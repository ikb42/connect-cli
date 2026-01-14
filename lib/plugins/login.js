/* global Promise */

/**
 * Module dependencies
 */

var url = require('url')
var qs = require('qs')
var fetch = require('node-fetch')
var { CookieJar } = require('tough-cookie')
var https = require('https')
var http = require('http')
var AnvilConnect = require('anvil-connect-nodejs')

/**
 * Add login command to Anvil Connect Node.js client
 */

function extendLogin (cli, options, done) {
  // Helper function to create MFA error
  function createMfaError (data) {
    var error = new Error(data.message || 'Multi-factor authentication is required to sign-in.')
    error.name = 'MfaRequiredError'
    error.error = data.error || 'mfa_required'
    error.allowed_methods = data.allowed_methods || ['totp']
    error.missingMfaCode = data.missingMfaCode !== undefined ? data.missingMfaCode : true
    return error
  }

  // Helper function to get location header from response
  function getLocationHeader (headers) {
    return headers.location || headers.Location
  }

  // Helper function to exchange authorization code for token
  function exchangeToken (self, code, resolve, reject) {
    self.token({ code: code })
      .then(function (data) {
        resolve(data)
      })
      .catch(function (err) {
        reject(err)
      })
  }

  // Helper function to handle redirect location
  // Returns: { handled: true, result: error|undefined } if handled, { handled: false } otherwise
  function handleRedirect (location, self, resolve, reject) {
    if (!location) {
      return { handled: false }
    }

    var u = url.parse(location)
    var query = qs.parse(u.query)

    // Check if redirect is to /signin/mfa - this indicates MFA is required
    if (u.pathname && (u.pathname.indexOf('/signin/mfa') !== -1 || u.pathname.indexOf('/mfa') !== -1)) {
      reject(createMfaError({
        error: 'mfa_required',
        message: 'Multi-factor authentication is required to sign-in.',
        allowed_methods: ['totp']
      }))
      return { handled: true }
    }

    // Check for MFA error in redirect query parameters
    if (query.error === 'mfa_required' && query.missingMfaCode === 'true') {
      reject(createMfaError({
        error: query.error,
        message: query.message,
        allowed_methods: query.allowed_methods ? query.allowed_methods.split(',') : []
      }))
      return { handled: true }
    }

    // Check for other errors in redirect
    if (query.error) {
      reject(new Error(query.error_description || query.error || 'Authentication failed'))
      return { handled: true }
    }

    // Check for authorization code
    if (query.code) {
      exchangeToken(self, query.code, resolve, reject)
      return { handled: true }
    }

    return { handled: false }
  }

  // add login method to anvil client
  function login (credentials, issuer) {
    var self = this
    var input = {}

    // Create or reuse a cookie jar to maintain session between requests
    // Store it on the client instance so it persists between login attempts
    if (!self._cookieJar) {
      self._cookieJar = new CookieJar()
    }
    var cookieJar = self._cookieJar

    // construct the endpoint
    // this one isn't included in openid-configuration
    // Use /signin/mfa if MFA code is provided
    var uri = this.issuer + (credentials.mfaCode ? '/signin/mfa' : '/signin')

    // authorization parameters
    var params = this.authorizationParams(input)

    // password login params
    if (!issuer.fields) {
      params.provider = 'password'
      params.email = credentials.email
      params.password = credentials.password
      params.scope = 'openid profile realm'

    // alternate provider login params
    } else {
      params.provider = issuer.provider
      issuer.fields.forEach(field => {
        params[field.name] = credentials[field.name]
      })
      params.scope = 'openid profile realm'
    }

    // add MFA code if provided
    if (credentials.mfaCode) {
      params.mfaCode = credentials.mfaCode
    }

    // authorization request
    return new Promise(function (resolve, reject) {
      // Prepare fetch options
      var fetchOptions = {
        method: 'POST',
        headers: {
          'referer': uri,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        redirect: 'manual' // Don't follow redirects automatically
      }
      
      // Handle form data
      fetchOptions.body = qs.stringify(params)
      
      // Handle SSL agent options
      if (self.agentOptions) {
        var urlObj = url.parse(uri)
        if (urlObj.protocol === 'https:') {
          fetchOptions.agent = new https.Agent({
            rejectUnauthorized: self.agentOptions.rejectUnauthorized !== false,
            ca: self.agentOptions.ca
          })
        } else if (urlObj.protocol === 'http:') {
          fetchOptions.agent = new http.Agent()
        }
      }
      
      // Get cookies from jar and add to headers
      cookieJar.getCookieString(uri, function (err, cookieString) {
        if (!err && cookieString) {
          fetchOptions.headers['Cookie'] = cookieString
        }
        
        fetch(uri, fetchOptions)
          .then(async function (response) {
            // Handle cookies from response
            var setCookieHeaders = response.headers.raw()['set-cookie']
            if (setCookieHeaders) {
              var setCookies = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders]
              for (var i = 0; i < setCookies.length; i++) {
                cookieJar.setCookieSync(setCookies[i], uri)
              }
            }
            
            // Create response headers object (lowercase keys for compatibility)
            var responseHeaders = {}
            response.headers.forEach(function (value, key) {
              responseHeaders[key.toLowerCase()] = value
            })
            
            var statusCode = response.status
            
            // Parse response body
            var body
            var contentType = response.headers.get('content-type') || ''
            var isJson = contentType.indexOf('application/json') !== -1 || 
                         contentType.indexOf('application/vnd.api+json') !== -1
            
            if (isJson) {
              try {
                body = await response.json()
              } catch (e) {
                body = await response.text()
              }
            } else {
              body = await response.text()
            }
            
            // Create a response-like object for compatibility
            var responseObj = {
              statusCode: statusCode,
              status: statusCode,
              headers: responseHeaders,
              body: body
            }
            
            // Handle redirects (3xx) - treat as errors for compatibility
            if (statusCode >= 300 && statusCode < 400) {
              var location = responseHeaders.location
              if (location) {
                var redirectError = new Error('Redirect')
                redirectError.statusCode = statusCode
                redirectError.response = responseObj
                redirectError.response.headers = responseHeaders
                redirectError.response.headers.location = location
                throw redirectError
              }
            }
            
            return responseObj
          })
          .then(function (response) {
            var body = response.body
            var statusCode = response.statusCode
            var location = getLocationHeader(response.headers)

            // Check if response is JSON and contains MFA error
            if (statusCode === 200 && body && typeof body === 'object') {
              if (body.error === 'mfa_required' && body.missingMfaCode) {
                reject(createMfaError({
                  error: body.error,
                  message: body.message,
                  allowed_methods: body.allowed_methods,
                  missingMfaCode: body.missingMfaCode
                }))
                return
              }
              
              // Check if response contains an explicit error
              if (body.error && body.error !== 'mfa_required') {
                reject(new Error(body.error_description || body.message || body.error || 'Authentication failed'))
                return
              }
              
              // Check if this looks like a welcome/info message (not a success response)
              if (body['Anvil Connect'] || (body.issuer && body.version && !body.code && !body.access_token)) {
                if (location) {
                  var handled = handleRedirect(location, self, resolve, reject)
                  if (handled.handled) {
                    return
                  }
                }
                reject(new Error('Bad username or password'))
                return
              }
            }

            // Handle 200 OK responses
            if (statusCode === 200) {
              if (location) {
                var handled = handleRedirect(location, self, resolve, reject)
                if (handled.handled) {
                  return
                }
              }
              reject(new Error('Bad username or password'))
              return
            }

            // Handle redirects (302)
            if (statusCode === 302) {
              if (!location) {
                reject(new Error('Redirect response missing location header'))
                return
              }

              var handled = handleRedirect(location, self, resolve, reject)
              if (handled.handled) {
                return
              }

              reject(new Error('Authorization code not found in redirect'))
              return
            }

            // Other status codes
            reject(new Error('Unexpected response status: ' + statusCode))
          })
          // Handle request errors
          .catch(function (err) {
            // If it's already an MfaRequiredError, pass it through
            if (err.name === 'MfaRequiredError') {
              reject(err)
              return
            }

            // Check if error response contains redirect (3xx status codes)
            if (err.response && err.statusCode >= 300 && err.statusCode < 400) {
              var location = getLocationHeader(err.response.headers)
              if (location) {
                var handled = handleRedirect(location, self, resolve, reject)
                if (handled.handled) {
                  return
                }
              }
            }

            reject(err)
          })
      })
    })
  }

  AnvilConnect.prototype.login = login

  done()
}

/**
 * Exports
 */

module.exports = extendLogin
