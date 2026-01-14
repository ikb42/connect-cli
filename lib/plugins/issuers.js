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
    promise.then(function (answers) {
      callback(answers)
    }).catch(function (err) {
      // Only call callback with error if it's not an ExitPromptError
      // ExitPromptError means user cancelled, which should be handled differently
      if (err && err.name !== 'ExitPromptError') {
        callback(err)
      }
      // Otherwise, let the error propagate or handle it silently
    })
  }
  return promise
}
var mkdirp = require('mkdirp')
var path = require('path')
var fs = require('fs')
var _s = require('underscore.string')

/**
 * Issuer management
 */

function registerIssuers (cli, options, done) {
  var configPath = path.join(cli.env.nvl, 'issuers')
  var sessionPath = path.join(cli.env.nvl, 'sessions')

  var issuers = {}

  cli.issuers = {
    refresh: function () {
      mkdirp.sync(configPath)
      mkdirp.sync(sessionPath)

      issuers = {}

      var issuerConfigs = []
      try {
        issuerConfigs = fs.readdirSync(configPath)
      } catch (e) {
        // Directory doesn't exist or can't be read, continue with empty array
        cli.log('Warning: Could not read issuers directory at ' + configPath + ': ' + e.message)
      }

      issuerConfigs.forEach(function (issuerConfigPath) {
        if (path.extname(issuerConfigPath) === '.yaml') {
          try {
            var name = path.basename(issuerConfigPath, '.yaml')
            var issuer = cli.fs.read(
              path.join(configPath, issuerConfigPath),
              'yaml'
            )
            issuer.name = issuer.name || _s.humanize(name)
            issuer.fileName = name
            issuer.session = {}
            issuers[name] = issuer
          } catch (e) {}
        }
      })

      var issuerSessions = []
      try {
        issuerSessions = fs.readdirSync(sessionPath)
      } catch (e) {
        // Directory doesn't exist or can't be read, continue with empty array
        cli.log('Warning: Could not read sessions directory at ' + sessionPath + ': ' + e.message)
      }

      issuerSessions.forEach(function (issuerSessionPath) {
        if (path.extname(issuerSessionPath) === '.json') {
          try {
            var name = path.basename(issuerSessionPath, '.json')
            if (issuers[name]) {
              issuers[name].session = cli.fs.read(
                path.join(sessionPath, issuerSessionPath),
                'json'
              )
            }
          } catch (e) {}
        }
      })

      return issuers
    },

    list: function () {
      return Object.getOwnPropertyNames(issuers).map(function (name) {
        return issuers[name]
      })
    },

    load: function (name, useDefault) {
      // Issuer specified
      if (name) {
        if (issuers[name]) {
          return issuers[name]
        } else {
          throw new Error('No issuer with name ' + name)
        }
      // No issuer specified
      } else {
        var names = Object.getOwnPropertyNames(issuers)

        // No configured issuers
        if (!names.length) {
          throw new Error('No configured issuers. Run `nvl register` or `nvl setup`.')
        // Only one configured issuer
        } else if (names.length === 1) {
          return issuers[names[0]]
        // Multiple configured issuers, but default set
        } else if (useDefault !== false && cli.config.data.defaultIssuer) {
          return issuers[cli.config.data.defaultIssuer]
        // Multiple configured issuers, but no default set
        } else {
          throw new Error('Multiple configured issuers, but no default set.')
        }
      }
    },

    save: function (issuer, name) {
      if (!issuer && !name) {
        throw new Error('Cannot determine issuer name')
      }

      issuer = issuer || {}
      var session = issuer.session || {}
      name = name || issuer.fileName || _s.slugify(issuer.name)
      issuer.name = issuer.name || _s.humanize(name)

      delete issuer.session
      delete issuer.fileName

      try {
        mkdirp.sync(configPath)
        cli.fs.write(path.join(configPath, name + '.yaml'), issuer, 'yaml')
      } catch (e) {
        issuer.session = session
        issuer.fileName = name
        throw e
      }

      issuer.session = session
      issuer.fileName = name

      mkdirp.sync(sessionPath)
      cli.fs.write(path.join(sessionPath, name + '.json'), session, 'json')

      issuers[name] = issuer
    },

    del: function (issuer) {
      var fileName = issuer

      if (typeof issuer === 'object') {
        fileName = issuer.fileName
      }

      var issuerConfigPath = path.join(configPath, fileName + '.yaml')
      var issuerSessionPath = path.join(sessionPath, fileName + '.json')

      cli.fs.del(issuerConfigPath)
      cli.fs.del(issuerSessionPath)

      delete issuers[fileName]
    },

    prompt: function (choice, callback) {
      if (!callback) {
        callback = choice
        choice = null
      }

      var options = (choice && typeof choice === 'object') ? choice : {}
      choice = (choice && typeof choice === 'object') ? options.choice : choice

      var issuerList = Object.getOwnPropertyNames(issuers).map(function (name) {
        return {
          name: issuers[name].name + ' (' + name + ')',
          value: name
        }
      })
      var issuer

      if (!choice &&
        (issuerList.length > 1 || options.alwaysPrompt || options.useDefault === false)
      ) {
        inquirer.prompt([
          {
            message: 'Select an Anvil Connect instance',
            type: 'select',
            name: 'issuer',
            choices: issuerList
          }
        ], function (answers) {
          issuer = issuers[answers.issuer]
          if (!issuer) {
            callback(
              new Error(
                'Error loading configuration for \'' + answers.issuer + '\''
              )
            )
          }
          if (!options.quiet) {
            cli.log('Selected issuer ' + issuer.name + ' (' + issuer.issuer + ')')
          }
          callback(null, issuer)
        })
      } else {
        try {
          issuer = cli.issuers.load(choice, options.useDefault)
          if (!options.quiet) {
            cli.log('Selected issuer ' + issuer.name + ' (' + issuer.issuer + ')')
          }
        } catch (e) {
          return callback(e)
        }

        if (!issuer) {
          return callback(
            new Error('Cannot find configuration for issuer \'' + choice + '\'')
          )
        }

        callback(null, issuer)
      }
    }
  }

  cli.issuers.refresh()

  done()
}

/**
 * Exports
 */

module.exports = registerIssuers
