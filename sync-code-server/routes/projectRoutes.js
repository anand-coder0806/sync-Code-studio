const express = require('express');
const auth = require('../middleware/auth');
const { requireWritePermissionForWriteMethods } = require('../middleware/authorization');
const {
  listProjects,
  createProject,
  getProject,
  updateProject,
  deleteProject,
  shareProject,
  getSharedProject,
} = require('../controllers/projectController');

const router = express.Router();

// Public shared route
router.get('/shared/:shareId', getSharedProject);

router.use(auth);
router.use(requireWritePermissionForWriteMethods);

router.get('/', listProjects);
router.post('/', createProject);
router.get('/:projectId', getProject);
router.put('/:projectId', updateProject);
router.delete('/:projectId', deleteProject);
router.post('/:projectId/share', shareProject);

module.exports = router;