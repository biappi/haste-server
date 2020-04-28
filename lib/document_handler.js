var winston = require('winston');
var Busboy = require('busboy');

// For handling serving stored documents

var DocumentHandler = function(options) {
  if (!options) {
    options = {};
  }
  this.keyLength = options.keyLength || DocumentHandler.defaultKeyLength;
  this.maxLength = options.maxLength; // none by default
  this.store = options.store;
  this.keyGenerator = options.keyGenerator;
};

DocumentHandler.defaultKeyLength = 10;

// Handle retrieving a document
DocumentHandler.prototype.handleGet = function(key, response, skipExpire) {
  this.store.get(key, function(ret) {
    if (ret) {
      winston.verbose('retrieved document', { key: key });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: ret, key: key }));
    }
    else {
      winston.warn('document not found', { key: key });
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'Document not found.' }));
    }
  }, skipExpire);
};

// Handle retrieving a file
DocumentHandler.prototype.handleGetFile = function(key, response, skipExpire) {
  const _this = this;

  key = 'file-' + key
  this.store.get(key + '-type', function(ct) {
    if (ct) {
      _this.store.get(key, function(ret) {
        if (ret) {
          winston.verbose('retrieved file', { key: key });
          response.writeHead(200, { 'content-type': ct });

          const decoded = new Buffer(ret, 'base64');
          response.end(decoded);
        }
        else {
          winston.warn('file  not found', { key: key });
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ message: 'Document not found.' }));
        }
      }, skipExpire);
    }
    else {
      winston.warn('file meta not found', { key: key });
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'Document not found.' }));
    }
  }, skipExpire);
};

// Handle retrieving the raw version of a document
DocumentHandler.prototype.handleRawGet = function(key, response, skipExpire) {
  this.store.get(key, function(ret) {
    if (ret) {
      winston.verbose('retrieved raw document', { key: key });
      response.writeHead(200, { 'content-type': 'text/plain; charset=UTF-8' });
      response.end(ret);
    }
    else {
      winston.warn('raw document not found', { key: key });
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'Document not found.' }));
    }
  }, skipExpire);
};

// Handle adding a new Document
DocumentHandler.prototype.handlePost_base = function (request, response, isFile) {
  var _this = this;
  var buffer = '';
  var file_type = ''
  var cancelled = false;

  // What to do when done

  var doSet = function(key, buffer) {
    _this.store.set(key, buffer, function (res) {
      if (res) {
        if (isFile)
            key = key.substring("file-".length)

        winston.verbose('added document', { key: key });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ key: key }));
      }
      else {
        winston.verbose('error adding document');
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ message: 'Error adding document.' }));
      }
    });
  };

  var onSuccess = function () {
    // Check length
    if (_this.maxLength && buffer.length > _this.maxLength) {
      cancelled = true;
      winston.warn('document >maxLength', { maxLength: _this.maxLength });
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ message: 'Document exceeds maximum length.' })
      );
      return;
    }
    // And then save if we should
    _this.chooseKey(function (key) {
      if (isFile) {
        key = 'file-' + key

        _this.store.set(key + '-type', file_type, function(res) {
          if (res) {
            const encoded = buffer.toString('base64')
            doSet(key, encoded);
          }
          else {
            winston.verbose('error adding file meta');
            response.writeHead(500, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ message: 'Error adding document.' }));
          }
        });
      }
      else {
        doSet(key, buffer);
      }
    });
  };

  // If we should, parse a form to grab the data
  var ct = request.headers['content-type'];
  if (ct && ct.split(';')[0] === 'multipart/form-data') {
    var busboy = new Busboy({ headers: request.headers });
    busboy.on('field', function (fieldname, val) {
      if (fieldname === 'data') {
        buffer = val;
      }
    });

    const data_chunks = [];

    busboy.on('file', function(fieldname, file, filename, encoding, mimetype) {
      file_type = mimetype;

      file.on('data', function(data) {
        data_chunks.push(data);
      });

      file.on('end', function() {
        buffer = Buffer.concat(data_chunks);
      });
    });


    busboy.on('finish', function () {
      onSuccess();
    });

    request.pipe(busboy);

  // Otherwise, use our own and just grab flat data from POST body
  } else {
    request.on('data', function (data) {
      buffer += data.toString();
    });
    request.on('end', function () {
      if (cancelled) { return; }
      onSuccess();
    });
    request.on('error', function (error) {
      winston.error('connection error: ' + error.message);
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'Connection error.' }));
      cancelled = true;
    });
  }
};

DocumentHandler.prototype.handlePost = function (request, response) {
    this.handlePost_base(request, response, false);
}

DocumentHandler.prototype.handlePostFile = function (request, response) {
    this.handlePost_base(request, response, true);
}

// Keep choosing keys until one isn't taken
DocumentHandler.prototype.chooseKey = function(callback) {
  var key = this.acceptableKey();
  var _this = this;
  this.store.get(key, function(ret) {
    if (ret) {
      _this.chooseKey(callback);
    } else {
      callback(key);
    }
  }, true); // Don't bump expirations when key searching
};

DocumentHandler.prototype.acceptableKey = function() {
  return this.keyGenerator.createKey(this.keyLength);
};

module.exports = DocumentHandler;
