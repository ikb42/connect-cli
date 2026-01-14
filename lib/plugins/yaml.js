/**
 * Module dependencies
 */

var yaml = require('js-yaml')

/**
 * Register YAML utilities
 */

function registerYAML (cli, options, done) {
  cli.fs.registerSerializer('yaml', function (obj, opts) {
    opts = opts || {}

    var copy = {}

    Object.getOwnPropertyNames(obj).forEach(function (prop) {
      if (typeof obj[prop] !== 'undefined') {
        copy[prop] = obj[prop]
      }
    })

    return yaml.dump(copy, opts)
  })

  cli.fs.registerDeserializer('yaml', function (data, opts) {
    opts = opts || {}

    return yaml.load(data, opts)
  })

  done()
}

/**
 * Exports
 */

module.exports = registerYAML
