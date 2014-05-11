var path = require('path');
var fs = require('fs');
var fsExtra = require('fs.extra');
var utils = require('./utils');

exports.handleSave = function(req, res, app) {
  var data = req.param('data', null);
  var sourcefile = req.param('source', null);
  var mode = req.param('mode', null);
  var conditional = req.param('conditional', null);
  var key = req.param('key', null);
  var sourcekey = req.param('sourcekey', key);

  try {
    var user = utils.getUser(req, app);
    var filename = req.param("file", utils.filenameFromUri(req));
    var origfilename = filename;

    /*
    console.log({
      user: user,
      key: key,
      filename: filename,
      mode: mode,
      data: data,
      sourcefile: sourcefile,
      conditional: conditional});
    */

    try {
      fsExtra.removeSync(utils.getRootCacheName(app));
    }
    catch (e) { }

    //
    // Validate parameters
    //

    if (data && sourcefile) {
      utils.errorExit('Cannot supply both data and source');
    }

    if (mode) {
      switch (mode) {
        case 'mv':
          if (!sourcefile) {
            utils.errorExit('No source specified for mv');
          }
          break;
        case 'a':
          if (!data) {
            utils.errorExit('No data specified for append');
          }
          break;
        case 'setkey':
          if (!data && sourcefile) {
            utils.errorExit('Invalid parameters specified for setkey');
          }
          break;
        case 'rmtree':
          if (data || sourcefile) {
            utils.errorExit('Either data or source specified for rmtree');
          }
          break;
        default:
          utils.errorExit('Unknown mode type');
      }
    }

    if (conditional) {
      conditional = new Date(conditional);
    }

    // validate username
    if (user) {
      utils.validateUserName(user);
      filename = path.join(user, filename);
    }

    var topdir = false;
    if (!utils.isFileNameValid(filename, true)) {
      if (mode == 'setkey' ||
          (!data && (mode == 'rmtree' || mode == 'mv' || !sourcefile)) &&
          /^[\w][\w\\-]*\/?$/.test(filename)) {
        topdir = true;
      }
      else {
        utils.errorExit('Bad filename ' + filename);
      }
    }

    var absfile = utils.makeAbsolute(filename, app);
    var userdir = null;
    if (user) {
      userdir = utils.getUserHomeDir(user, app);
    }

    //
    // Validate that users key matches the supplied key
    //

    if (!isValidKey(user, key, app)) {
      var msg = (key) ? 'Incorrect password.' : 'Password protected.';
      res.json({error: msg, 'needauth': 'key'});
      return;
    }

    //
    // Handle setkey
    //

    if (mode == 'setkey') {
      if (!topdir) {
        utils.errorExit('Can only set key on a top-level user directory.');
      }

      doSetKey(user, key, data, res, app);
      res.json((data) ? {keyset: user} : {keycleared: user});
      return;
    }

    //
    // Handle the copy/move case
    //

    if (sourcefile) {
      if (!/^(?:[\w][\w\.\-]*)(?:\/[\w][\w\.\-]*)*\/?$/.test(sourcefile)) {
        utils.errorExit('Bad source filename: ' + sourcefile);
      }

      sourceuser = filenameuser(sourcefile);
      var absSourceFile = utils.makeAbsolute(sourcefile, app);
      if (!fs.existsSync(absSourceFile)) {
        utils.errorExit('Source file does not exist. ' + sourcefile);
      }

      // Only directories can be copied or moved to the top
      if (topdir && !fs.statSync(absSourceFile).isDirectory()) {
        utils.errorExit('Bad filename. ' + filename);
      }

      // mv requires authz on the source dir
      if (mode == 'mv') {
        if (!isValidKey(sourceuser, sourcekey, app)) {
          var msg = (!key) ?
              'Source password protected.' : 'Incorrect source password.';
          res.json({error: msg, 'auth': 'key'});
          return;
        }
      }

      // Create target parent directory if needed
      if (!fs.statSync(path.dirname(absfile)).isDirectory()) {
        checkReservedUser(user, app);
        try {
          fs.mkdirSync(path.dirname(absfile));
        }
        catch (e) {
          utils.errorExit('Could not create dir: ' + path.dirname(filename));
        }
      }

      // move case
      if (mode == 'mv') {
        if (fs.existsSync(absfile)) {
          utils.errorExit('Cannot replace existing file: ' + filename);
        }

        try {
          fs.renameSync(absSourceFile, absfile);

          // Cleanup directories if necessary
          var dir = path.dirname(absSourceFile);
          for (; dir ; dir = path.dirname(dir)) {
            try {
              fs.rmdirSync(dir);
            }
            catch (e) {
              // Failed to remove dir, assume not empty
              break;
            }
          }

          // Remove .key when moving top dir into deeper dir because we don't
          // want to propagate password data
          if (topdir && filename != user) {
            fsExtra.removeSync(path.join(absfile, '.key'));
          }
        }
        catch (e) {
          utils.errorExit('Could not move ' + sourcefile + ' to ' + filename);
        }
      }
      else {
        // Copy case
        try {
          // Are we copying a directory?
          if (fs.stat(absSourceFile).isDirectory()) {
            if (fs.existsSync(absfile)) {
              utils.errorExit(
                  'Cannot overwwrite existing directory ' + filename);
            }

            fsExtra.copySync(absSourceFile, absfile);
            // TODO: Need to ignore .key subdirs and contents
          }
          else {
            fsExtra.copySync(absSourceFile, absfile);
          }
        }
        catch (e) {
          utils.errorExit('Could not copy ' + sourcefile + ' to ' + filename);
        }
      }

      touchUserDir(userdir);
      res.json({saved: '/' + filename});
      return;
    }

    //
    // Enforce the conditional request if present
    //

    if (conditional) {
      if (fs.existsSync(absfile)) {
        mtime = fs.statSync(absfile).mtime.getTime();
        if (mtime > conditional) {
            res.json({error: 'Did not overwrite newer file.',
                      newer: mtime});
            return;
        }
      }
    }

    //
    // Handle the delete case
    //

    if (!data) {
        //if (!req.body.hasOwnProperty('data')) {
        //utils.errorExit('Missing data= form field argument.');
        //}

      if (fs.existsSync(absfile)) {
        try {
          fsExtra.removeSync(absfile);
        } catch (e) {
          utils.errorExit('Could not remove: ' + absfile);
        }

        try {
          removeDirsSync(path.dirname(absfile));
        } catch (e) { }
      }

      if (userdir != absfile) {
        touchUserDir(userdir);
      }

      res.json({'deleted' : filename});
      return;
    }

    // Validate data
    if (data.length > 1024 * 1024) {
      utils.errorExit('Data too large.');
    }

    //
    // Finally handle the create/replace case
    //

    if (!fs.existsSync(path.dirname(absfile)) ||
        !fs.statSync(path.dirname(absfile)).isDirectory()) {
      checkReservedUser(user, app);
      try {
        fsExtra.mkdirsSync(path.dirname(absfile));
      }
      catch (e) {
        utils.errorExit('Could not create dir: ' + path.dirname(filename));
      }
    }

    var statObj;
    try {
      var openMode = (mode == 'a') ? 'a' : 'w';
      fd = fs.openSync(absfile, openMode);

      writeStream = fs.createWriteStream(absfile, {flags: openMode});
      writeStream.write(data);
      writeStream.end();

      writeStream.on('close', function() {
        fs.fsyncSync(fd);
        fs.closeSync(fd);

        statObj = fs.statSync(absfile);
        touchUserDir(userdir);

        res.json({
          saved: '/' + filename,
          mtime: statObj.mtime.getTime(),
          size: statObj.size
        });
      });
      return;
    }
    catch (e) {
      utils.errorExit('Error writing file: ' + absfile);
    }

    return;
  }
  catch (e) {
    if (e instanceof utils.ImmediateReturnError) {
      res.json(e.jsonObj);
    }
    else {
      throw e;
    }
  }
}

function touchUserDir(userdir) {
  try {
    var now = new Date;
    fs.utimesSync(userdir, now, now);
  }
  catch (e) { }
}

function filenameuser(filename) {
  var m = filename.match(/^([\w][\w\.\-]*)(?:\/.*)?$/);

  return (m) ? m[1] : null;
}

function removeDirsSync(dirStart) {
  for (var dir = dirStart; ; dir = path.dirname(dir)) {
    if (fs.readdirSync(dir).length > 0) {
      // Directory not empty, we're done.
      return;
    }

    fsExtra.remove(dir);
  }
}

function isValidKey(user, key, app) {
  //
  // keydir is the directory containing the hashed user password.
  // It's a subdir off the user home directory called '.key'.
  // Contents of this directory are files that are named
  // with the hashed user password
  //

  var keydir = utils.getKeyDir(user, app);
  var statObj = null;

  if (!utils.isPresent(keydir, 'dir')) {
    return true;
  }

  // Now we know its a directory
  var keys = fs.readdirSync(keydir);
  if (!keys || keys.length == 0) {
    // No key files, must mean no password for user.
    // So assume that this is valid.
    return true;
  }

  if (key) {
    for (var i = 0; i < keys.length; i++) {
      //
      // Password files are named with 'k' + the hashed password.
      // See doSetKey() for implementation.  So check the substring
      // offset with 1 to ignore the starting 'k'
      //
      if (key.indexOf(keys[i].substring(1)) == 0) {
        return true;
      }
    }
  }
}

//
// Create a file with the hashed user password in the
// user key dir.  This is called when the user sets or changes
// their password.
//
function doSetKey(user, oldkey, newkey, res, app) {
  if (oldkey == newkey) {
    return;
  }

  var keydir = utils.getKeyDir(user, app);

  try {
    // Create directory if not present
    if (!fs.existsSync(keydir)) {
      checkReservedUser(user, app);
      fsExtra.mkdirsSync(keydir);
    }

    if (oldkey) {
      //
      // Delete old password file if present
      //

      var keys = fs.readdirSync(keydir);

      for (var i = 0; i < keys.length; i++) {
        if (oldkey.indexOf(keys[i].substring(1)) == 0) {
          fs.unlink(path.join(keydir, keys[i]));
        }
      }
    }

    if (newkey) {
      // Now create new password file
      keyfile = path.join(keydir, 'k' + newkey);
      fs.closeSync(fs.openSync(keyfile, 'w'));
    }
  }
  catch (e) {
    utils.errorExit('Could not set key.');
  }
}


function checkReservedUser(user, app) {
  var datadirAbs = path.resolve(app.locals.config.dirs.datadir);

  if (fs.existsSync(path.join(datadirAbs, user))) {
    return;
  }

  if (user != user.toLowerCase()) {
    utils.errorExit('Username should be lowercase.');
  }

  var normalized = user.toLowerCase();
  if (fs.existsSync(path.join(datadirAbs, normalized))) {
    utils.errorExit('Username is reserved.');
  }

  // Also check possible variations of badwords
  var normalizedi = translate(normalized, '013456789', 'oieasbtbg');
  if (normalized != normalizedi &&
      fs.existsSync(path.join(datadirAbs, normalizedi))) {
    utils.errorExit('Username is reserved.');
  }

  var normalizedl = translate(normalized, '013456789', 'oleasbtbg');
  if (normalizedl != normalized &&
      fs.existsSync(path.join(datadirAbs, normalizedl))) {
    utils.errorExit('Username is reserved.');
  }

  var checkwords = [normalized, normalizedi, normalizedl];
  var badwords =
      fs.readFileSync(path.join(__dirname, 'bad-words.txt'), 'utf8').
          split(/\n/);
  var badsubstrings =
      fs.readFileSync(path.join(__dirname, 'bad-substrings.txt'), 'utf8').
          split(/\n/);

  for (var i = 0; i < checkwords.length; i++) {
    for (var j = 0; j < badwords.length; j++) {
      if (badwords[j].length > 0 && checkwords[i] == badwords[j]) {
        utils.errorExit('Username is reserved.');
      }
    }
    for (var j = 0; j < badsubstrings.length; j++) {
      if (badsubstrings[j].length > 0 && 
          checkwords[i].indexOf(badsubstrings[j]) != -1) {
        utils.errorExit('Username is reserved.');
      }
    }
  }
}

function translate(source, from, to) {
  var fromArr = from.split('');
  var toArr = to.split('');
  var copy = new String(source);

  if (fromArr.length != toArr.length) {
    utils.errorExit('Uh oh, parameters to translate are incorrect.');
  }

  for (var i = 0; i < fromArr.length; i++) {
    var x = copy.indexOf(fromArr[i]);
    if (x != -1) {
      // Match found, so replace it
      copy[x] = toArr[i];
    }
  }
  return copy;
}
