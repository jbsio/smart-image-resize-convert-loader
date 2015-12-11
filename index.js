// Options
//  @sizes Array of Integers
//    require('resize-image?sizes[]=200w,sizes[]=900w!./myImage.jpg');
//
//  @placeholder Integers (not compatible with sizes)
//    require('resize-image?placeholder=500!./myImage.jpg');
//  @blur Integers (not compatible with sizes)
//    require('resize-image?placeholder&blur=10!./myImage.jpg');
//
//  @format String ('jpg', 'gif', 'webp', 'png')
//    require('resize-image?format=webp!./myImage.jpg');

var debug = require('debug')('smart-image-resize-convert-loader');
var util = require('util');
var gm = require('gm').subClass({imageMagick: true});
var Datauri = require('datauri');
var fs = require('fs');
var path = require('path');
var loaderUtils = require('loader-utils');

var defaultSizes = ['320w', '960w', '2048w'];
var defaultBlur = 40;
var defaultPlaceholderSize = 20;

var queue = (function (q, c) {
  var max = 10;
  var push = function (fnc) {
      q.push(fnc);
      canDo();
    },
    canDo = function () {
      if (c < max && q.length > 0) {
        debug(q.length + " images remaining.");
        c++;
        q.shift()(next);
      }
    },
    next = function () {
      setTimeout(function () {
        c--;
        canDo();
      }, 0);
    };
  return {push: push, next: next};
}([], 0));

function createPlaceholder(content, placeholder, ext, blur, files) {
  return function (next) {

    var getSize = function () {
      gm(content)
        .size(function (err, _size) {
          if (err) {
            return;
          }
          if (!_size) {
            getSize();
            return;
          }
          setPlaceholder(_size);
        });
    };

    var setPlaceholder = function (size) {
      gm(content)
        .resize(placeholder)
        .toBuffer(ext, function (err, buf) {
          if (!buf) return;
          debug("placeholder: " + JSON.stringify(size));
          var uri = new Datauri().format('.' + ext, buf).content;
          var blur = "<svg xmlns='http://www.w3.org/2000/svg' width='100%' viewBox='0 0 " + size.width + " " + size.height + "'>" +
            "<defs><filter id='puppybits'><feGaussianBlur in='SourceGraphic' stdDeviation='" + defaultBlur + "'/></filter></defs>" +
            "<image width='100%' height='100%' xmlns:xlink='http://www.w3.org/1999/xlink' xlink:href='" + uri + "' filter='url(#puppybits)'></image>" +
            "</svg>";
          var micro = new Datauri().format('.svg', new Buffer(blur, 'utf8')).content;
          var response = {size: size, placeholder: micro};
          next(response);
        });
    };

    getSize();
  };
}

function createResponsiveImages(content, sizes, exts, name, emitFile, resourcePath) {
  return function (next) {
    var self = this;
    var images = [];

    var gmPromises = [];

    sizes.forEach(function (size, si) {
      exts.forEach(function (ext, ei) {
        gmPromises.push(new Promise(function (resolve, reject) {
          var index = this.index;
          var ext = this.ext;
          var size = parseInt(this.size);
          gm(content)
            .resize(size)
            .toBuffer(ext, function (err, buf) {
              var fileName = name + '-' + size + '.' + ext;
              var payload = {
                ext: ext,
                displaySize: size,
                fileName: fileName,
                baseName: name,
                path: resourcePath
              }
              if (buf) {
                payload.bufferSize = buf.length;
                emitFile(fileName, buf);
                return resolve(payload);
              }
              return reject(payload);
            });
        }.bind({ext: ext, size: size, index: (si * exts.length) + ei})));
      })
    });
    var statPromises = [];
    Promise.all(gmPromises)
      .then(function (results) {
        var filtered = results.filter(function (e) {
          return e !== undefined;
        });

        var map = {};
        filtered.forEach(function (e) {
          map = map || {};
          map[e.displaySize] = map[e.displaySize] || [];
          map[e.displaySize].push(e);
        });

        var sorted = {};
        for (var key in map) {
          if (map.hasOwnProperty(key)) {
            var val = map[key];
            sorted[key] = sorted[key] || [];
            sorted[key] = val.sort(function (a, b) {
              return a.bufferSize > b.bufferSize;
            });
          }
        }

        var flat = [];
        for (var key2 in sorted) {
          if (sorted.hasOwnProperty(key2)) {
            var val2 = sorted[key2];
            for (var key3 in val2) {
              if(val2.hasOwnProperty(key3)) {
                var val3 = val2[key3];
                flat.push({fileName: val3.fileName, displaySize: val3.displaySize});
              }
            }
          }
        }


        var imgset = flat.map(function (info, i) {
          return info.fileName + ' ' + info.displaySize;
        }).join('w, ') + 'w';

        next(imgset);
      })
      .catch(function (rejected) {
        throw new Error(i.fileName + ' was unsuccessfully generated.');
      });
  };
}

module.exports = function (content) {
  var idx = this.loaderIndex;
  var resourcePath = this.options.output.path;
  // ignore content from previous loader because it could be datauri
  content = fs.readFileSync(this.resourcePath);

  var query = (this.query !== '' ? this.query : this.loaders[0].query);
  query = loaderUtils.parseQuery(query);
  var size = !query.sizes && !query.placeholder && defaultSizes || [];

  query.sizes = (query.sizes && !Array.isArray(query.sizes) && [query.sizes]) || query.sizes || size;

  var extensions = query.formats || ['webp', 'png', 'jpg'];

  var callback = this.async();
  if (!this.emitFile) throw new Error("emitFile is required from module system");
  this.cacheable && this.cacheable();
  this.addDependency(this.resourcePath);

  if (this.debug === true && query.bypassOnDebug === true) {
    // Bypass processing while on watch mode
    return callback(null, content);
  } else {

    var paths = this.resourcePath.split('/');
    var file = paths[paths.length - 1];
    var name = file.slice(0, file.lastIndexOf('.'));
    var ext = file.slice(file.lastIndexOf('.') + 1, file.length);
    var sizes = query.sizes.map(function (s) {
      return s;
    });
    var emitFile = this.emitFile;

    var task1 = null,
      task2 = null;
    if (query.placeholder) {
      query.placeholder = parseInt(query.placeholder) || defaultPlaceholderSize;
      query.blur = query.blur || defaultBlur;

      task1 = createPlaceholder(content, query.placeholder, ext, query.blur, name);
    }

    if (sizes.length >= 1) {
      if (!task1) {
        task1 = createResponsiveImages(content, sizes, extensions, name, emitFile, resourcePath);
      } else {
        task2 = createResponsiveImages(content, sizes, extensions, name, emitFile, resourcePath);
      }
    }

    queue.push((function (t1, t2, callback) {
      return function (next) {
        if (t2) {
          t2(function (result) {
            t1(function (result2) {
              Object.keys(result2).map(function (key) {
                result[key] = result2[key];
              });
              debug(JSON.stringify(result, undefined, 1));
              callback(null, "module.exports = '" + result + "'");
              next();
            });
          });
          return;
        }


        t1(function (result) {
          debug(JSON.stringify(result, undefined, 1));
          callback(null, "module.exports = '" + result + "'");
          next();
        });
      };
    }(task1, task2, callback)));
  }
};

module.exports.raw = true; // get buffer stream instead of utf8 string
