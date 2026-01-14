/* global process */

/**
 * Module dependencies
 */

var inquirerModule = require('inquirer')
var inquirer = inquirerModule.default || inquirerModule

// Wrap Promise-based API to support callbacks for backward compatibility
var originalPrompt = inquirer.prompt
inquirer.prompt = function (questions, callback) {
  var promise = originalPrompt.call(this, questions)
  if (callback) {
    promise
      .then(function (answers) {
        callback(answers)
      })
      .catch(function (err) {
        // Only call callback with error if it's not an ExitPromptError
        // ExitPromptError means user cancelled, which should be handled differently
        if (err && err.name !== 'ExitPromptError') {
          callback(err)
        }
      })
  }
  return promise
}

/**
 * Login command
 */

function registerLogin (cli, options, done) {
  cli.command('login')
    .handler(function (data, flags, done) {
      cli.issuers.prompt(data[0], function (err, issuer) {
        if (err) {
          cli.log.error(err)
          process.exit(1)
        }

        try {
          var anvil = cli.client.create(issuer)
        } catch (e) {
          cli.log.error(e)
          process.exit(1)
        }

        // Get the provider configuration
        anvil.discover()
          .then(function (configuration) {
            // Helper function to attempt login
            function attemptLogin (credentialsWithMfa) {
              return anvil
                .getJWKs()
                .then(function (jwks) {
                  return anvil.login(credentialsWithMfa, issuer)
                })
                .then(function (tokens) {
                  issuer.session.tokens = tokens

                  try {
                    cli.issuers.save(issuer)
                  } catch (e) {
                    cli.log.error(e)
                    process.exit(1)
                  }

                  cli.log('You have been successfully logged in to ' + issuer.name)
                  done()
                })
                .catch(function (err) {
                  // Check if this is an MFA required error
                  if (err.name === 'MfaRequiredError' || (err.error === 'mfa_required' && err.missingMfaCode)) {
                    var mfaMessage = err.message || 'Multi-factor authentication is required to sign-in.'
                    var allowedMethods = err.allowed_methods || ['totp']

                    cli.log(mfaMessage)
                    if (allowedMethods.length > 0) {
                      cli.log('Allowed methods: ' + allowedMethods.join(', '))
                    }

                    inquirer.prompt([
                      {
                        type: 'input',
                        name: 'mfaCode',
                        message: 'Enter your MFA code',
                        validate: function (input) {
                          if (!input || input.trim().length === 0) {
                            return 'MFA code is required'
                          }
                          return true
                        }
                      }
                    ], function (mfaAnswer) {
                      // Retry login with MFA code
                      var updatedCredentials = Object.assign({}, credentialsWithMfa, {
                        mfaCode: mfaAnswer.mfaCode
                      })
                      attemptLogin(updatedCredentials)
                    })
                  } else {
                    // Other errors
                    cli.log.error(err)
                    done()
                  }
                })
            }

            // Prompt for email and password
            try {
              inquirer.prompt(issuer.fields || [
                {
                  type: 'input',
                  name: 'email',
                  message: 'Enter your email'
                },
                {
                  type: 'password',
                  name: 'password',
                  message: 'Enter your password'
                }
              ], function (credentials) {
                attemptLogin(credentials)
              })
            } catch (promptError) {
              // If inquirer.prompt throws synchronously, reject the promise
              return Promise.reject(promptError)
            }
          })
          .catch(function (err) {
            cli.log.error(err)
            cli.log.error(issuer.issuer + ' does not point to an Anvil Connect server')
            process.exit(1)
          })
      })
    })
  done()
}

/**
 * Export
 */

module.exports = registerLogin
