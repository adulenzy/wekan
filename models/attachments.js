import { Meteor } from 'meteor/meteor';
import { FilesCollection } from 'meteor/ostrio:files';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { createBucket } from './lib/grid/createBucket';
import fs from 'fs';
import FileType from 'file-type';
import path from 'path';
import { AttachmentStoreStrategyFilesystem, AttachmentStoreStrategyGridFs} from '/models/lib/attachmentStoreStrategy';
import FileStoreStrategyFactory, {moveToStorage, rename, STORAGE_NAME_FILESYSTEM, STORAGE_NAME_GRIDFS} from '/models/lib/fileStoreStrategy';

let asyncExec;
let attachmentUploadExternalProgram;
let attachmentUploadMimeTypes = [];
let attachmentUploadSize = 0;
let attachmentBucket;
let storagePath;

if (Meteor.isServer) {
  asyncExec = promisify(exec);
  attachmentBucket = createBucket('attachments');

  if (process.env.ATTACHMENTS_UPLOAD_MIME_TYPES) {
    attachmentUploadMimeTypes = process.env.ATTACHMENTS_UPLOAD_MIME_TYPES.split(',');
    attachmentUploadMimeTypes = attachmentUploadMimeTypes.map(value => value.trim());
  }

  if (process.env.ATTACHMENTS_UPLOAD_MAX_SIZE) {
    attachmentUploadSize = parseInt(process.env.ATTACHMENTS_UPLOAD_MAX_SIZE);

    if (isNaN(attachmentUploadSize)) {
      attachmentUploadSize = 0
    }
  }

  if (process.env.ATTACHMENTS_UPLOAD_EXTERNAL_PROGRAM) {
    attachmentUploadExternalProgram = process.env.ATTACHMENTS_UPLOAD_EXTERNAL_PROGRAM;

    if (!attachmentUploadExternalProgram.includes("{file}")) {
      attachmentUploadExternalProgram = undefined;
    }
  }

  storagePath = path.join(process.env.WRITABLE_PATH, 'attachments');
}

export const fileStoreStrategyFactory = new FileStoreStrategyFactory(AttachmentStoreStrategyFilesystem, storagePath, AttachmentStoreStrategyGridFs, attachmentBucket);

// XXX Enforce a schema for the Attachments FilesCollection
// see: https://github.com/VeliovGroup/Meteor-Files/wiki/Schema

Attachments = new FilesCollection({
  debug: false, // Change to `true` for debugging
  collectionName: 'attachments',
  allowClientCode: true,
/* Commenting out because this custom namingFunction did not work:
   https://github.com/veliovgroup/Meteor-Files/issues/847

  namingFunction(opts) {
    const filenameWithoutExtension = opts.meta.name.replace(/(.+)\..+/, "$1");
    const ret = opts.meta.fileId + "-original-" + filenameWithoutExtension;
    // remove fileId from meta, it was only stored there to have this information here in the namingFunction function
    delete opts.meta.fileId;
    return ret;
  },
*/
  storagePath() {
    const ret = fileStoreStrategyFactory.storagePath;
    return ret;
  },
  onAfterUpload(fileObj) {
    // current storage is the filesystem, update object and database
    Object.keys(fileObj.versions).forEach(versionName => {
      fileObj.versions[versionName].storage = STORAGE_NAME_FILESYSTEM;
    });

    Attachments.update({ _id: fileObj._id }, { $set: { "versions" : fileObj.versions } });

    let storageDestination = fileObj.meta.copyStorage || STORAGE_NAME_GRIDFS;
    Meteor.defer(() => Meteor.call('validateAttachmentAndMoveToStorage', fileObj._id, storageDestination));
  },
  interceptDownload(http, fileObj, versionName) {
    const ret = fileStoreStrategyFactory.getFileStrategy(fileObj, versionName).interceptDownload(http, this.cacheControl);
    return ret;
  },
  onAfterRemove(files) {
    files.forEach(fileObj => {
      Object.keys(fileObj.versions).forEach(versionName => {
        fileStoreStrategyFactory.getFileStrategy(fileObj, versionName).onAfterRemove();
      });
    });
  },
  // We authorize the attachment download either:
  // - if the board is public, everyone (even unconnected) can download it
  // - if the board is private, only board members can download it
  protected(fileObj) {
    // file may have been deleted already again after upload validation failed
    if (!fileObj) {
      return false;
    }

    const board = Boards.findOne(fileObj.meta.boardId);
    if (board.isPublic()) {
      return true;
    }

    return board.hasMember(this.userId);
  },
});

if (Meteor.isServer) {
  Attachments.allow({
    insert(userId, fileObj) {
      return allowIsBoardMember(userId, Boards.findOne(fileObj.boardId));
    },
    update(userId, fileObj) {
      return allowIsBoardMember(userId, Boards.findOne(fileObj.boardId));
    },
    remove(userId, fileObj) {
      return allowIsBoardMember(userId, Boards.findOne(fileObj.boardId));
    },
    fetch: ['meta'],
  });

  Meteor.methods({
    moveAttachmentToStorage(fileObjId, storageDestination) {
      check(fileObjId, String);
      check(storageDestination, String);

      const fileObj = Attachments.findOne({_id: fileObjId});
      moveToStorage(fileObj, storageDestination, fileStoreStrategyFactory);
    },
    renameAttachment(fileObjId, newName) {
      check(fileObjId, String);
      check(newName, String);

      const fileObj = Attachments.findOne({_id: fileObjId});
      rename(fileObj, newName, fileStoreStrategyFactory);
    },
    validateAttachment(fileObjId) {
      check(fileObjId, String);

      const fileObj = Attachments.findOne({_id: fileObjId});
      let isValid = true;

      if (attachmentUploadMimeTypes.length) {
        const mimeTypeResult = Promise.await(FileType.fromFile(fileObj.path));

        const mimeType = (mimeTypeResult ? mimeTypeResult.mime : fileObj.type);
        const baseMimeType = mimeType.split('/', 1)[0];

        isValid = attachmentUploadMimeTypes.includes(mimeType) || attachmentUploadMimeTypes.includes(baseMimeType + '/*') || attachmentUploadMimeTypes.includes('*');

        if (!isValid) {
          console.log("Validation of uploaded file failed: file " + fileObj.path + " - mimetype " + mimeType);
        }
      }

      if (attachmentUploadSize && fileObj.size > attachmentUploadSize) {
        console.log("Validation of uploaded file failed: file " + fileObj.path + " - size " + fileObj.size);
        isValid = false;
      }

      if (isValid && attachmentUploadExternalProgram) {
        let args = { ...attachmentUploadExternalProgram.args };

        for (let key in args) {
          if (args[key] == "%file") {
            args[key] = fileObj.path;
          }
        }

        Promise.await(asyncExec(attachmentUploadExternalProgram.replace("{file}", '"' + fileObj.path + '"')));
        isValid = fs.existsSync(fileObj.path);

        if (!isValid) {
          console.log("Validation of uploaded file failed: file " + fileObj.path + " has been deleted externally");
        }
      }

      if (!isValid) {
        Attachments.remove(fileObjId);
      }
    },
    validateAttachmentAndMoveToStorage(fileObjId, storageDestination) {
      check(fileObjId, String);
      check(storageDestination, String);

      Meteor.call('validateAttachment', fileObjId);

      const fileObj = Attachments.findOne({_id: fileObjId});

      if (fileObj) {
        console.debug("Validation of uploaded file completed: file " + fileObj.path + " - storage destination " + storageDestination);
        Meteor.defer(() => Meteor.call('moveAttachmentToStorage', fileObjId, storageDestination));
      }
    },
  });

  Meteor.startup(() => {
    Attachments.collection.createIndex({ 'meta.cardId': 1 });
    const storagePath = fileStoreStrategyFactory.storagePath;
    if (!fs.existsSync(storagePath)) {
      console.log("create storagePath because it doesn't exist: " + storagePath);
      fs.mkdirSync(storagePath, { recursive: true });
    }
  });
}

export default Attachments;
