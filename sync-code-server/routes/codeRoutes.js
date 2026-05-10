const express = require('express');
const auth = require('../middleware/auth');
const { requireWritePermissionForWriteMethods } = require('../middleware/authorization');
const {
  saveFile,
  autoSaveFile,
  loadFile,
  listFiles,
  listFileTree,
  deleteFile,
  ensureDefaultProject,
  createFile,
  createFolder,
  renameNode,
  moveNode,
  listFileVersions,
  restoreFileVersion,
  searchFiles,
} = require('../controllers/codeController');

const router = express.Router();

router.use(auth);
router.use(requireWritePermissionForWriteMethods);

router.get('/default-project', ensureDefaultProject);
router.get('/search', searchFiles);
router.post('/autosave', autoSaveFile);
router.post('/save', saveFile);
router.post('/file', createFile);
router.post('/folder', createFolder);
router.patch('/node/:fileId', renameNode);
router.patch('/move/:fileId', moveNode);
router.get('/list', listFiles);
router.get('/tree', listFileTree);
router.get('/:fileId/versions', listFileVersions);
router.post('/:fileId/versions/:versionId/restore', restoreFileVersion);
router.get('/:fileId', loadFile);
router.delete('/:fileId', deleteFile);

module.exports = router;