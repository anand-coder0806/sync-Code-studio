const Project = require('../models/Project');
const File = require('../models/File');
const FileVersion = require('../models/FileVersion');
const crypto = require('crypto');

const getUserId = (req) => req.user.userId;

const createContentHash = (content = '') => crypto
  .createHash('sha1')
  .update(String(content), 'utf8')
  .digest('hex');

const createVersionSnapshot = async ({
  userId,
  projectId,
  fileId,
  content,
  language,
  source = 'manual',
  force = false,
}) => {
  const normalizedContent = String(content ?? '');
  const contentHash = createContentHash(normalizedContent);

  const latestVersion = await FileVersion.findOne({ userId, projectId, fileId })
    .sort({ createdAt: -1 })
    .select('contentHash versionNumber')
    .lean();

  if (!force && latestVersion?.contentHash === contentHash) {
    return {
      created: false,
      duplicated: true,
      latestVersion,
      contentHash,
    };
  }

  const versionNumber = Number(latestVersion?.versionNumber || 0) + 1;

  const version = await FileVersion.create({
    userId,
    projectId,
    fileId,
    versionNumber,
    content: normalizedContent,
    language: language || 'javascript',
    contentHash,
    source,
  });

  return {
    created: true,
    duplicated: false,
    version,
    contentHash,
  };
};

const getNextSortOrder = async ({ userId, projectId, parentId = null }) => {
  const lastItem = await File.findOne({ userId, projectId, parentId })
    .sort({ sortOrder: -1 })
    .select('sortOrder')
    .lean();

  if (!lastItem || !Number.isFinite(lastItem.sortOrder)) {
    return 0;
  }

  return Number(lastItem.sortOrder) + 1;
};

const reorderSiblings = async ({ userId, projectId, parentId = null, movedFileId, targetIndex }) => {
  const siblings = await File.find({ userId, projectId, parentId }).sort({ sortOrder: 1, createdAt: 1 });
  const withoutMoved = siblings.filter((item) => String(item._id) !== String(movedFileId));

  const movingNode = await File.findOne({ _id: movedFileId, userId, projectId });
  if (!movingNode) {
    return;
  }

  const safeIndex = Math.max(0, Math.min(Number.isFinite(targetIndex) ? targetIndex : withoutMoved.length, withoutMoved.length));
  withoutMoved.splice(safeIndex, 0, movingNode);

  await Promise.all(
    withoutMoved.map((item, index) =>
      File.updateOne({ _id: item._id, userId, projectId }, { $set: { sortOrder: index, parentId } })
    )
  );
};

const getDefaultProject = async (userId) => {
  const defaultProjectName = 'Sync Code Workspace';

  let project = await Project.findOne({ userId, name: defaultProjectName });
  if (!project) {
    project = await Project.create({
      userId,
      name: defaultProjectName,
      description: 'Default workspace created automatically',
    });
  }

  return project;
};

const resolveTargetProject = async (userId, projectId) => {
  return projectId
    ? Project.findOne({ _id: projectId, userId })
    : getDefaultProject(userId);
};

const assertValidParentFolder = async ({ userId, projectId, parentId }) => {
  if (!parentId) {
    return null;
  }

  const parentNode = await File.findOne({ _id: parentId, userId, projectId }).lean();
  if (!parentNode) {
    return { status: 404, error: 'Parent folder not found' };
  }

  if ((parentNode.itemType || 'file') !== 'folder') {
    return { status: 400, error: 'parentId must reference a folder' };
  }

  return null;
};

exports.saveFile = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { fileId, projectId, fileName, code, language, parentId = null } = req.body;

    const targetProject = projectId
      ? await Project.findOne({ _id: projectId, userId })
      : await getDefaultProject(userId);

    if (!targetProject) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    let file = null;

    if (fileId) {
      file = await File.findOne({ _id: fileId, userId, projectId: targetProject._id });
    }

    if (!file) {
      file = await File.findOne({
        userId,
        projectId: targetProject._id,
        name: fileName,
        itemType: 'file',
        parentId,
      });
    }

    if (file) {
      file.name = fileName || file.name;
      file.content = code ?? file.content;
      file.language = language || file.language;
      file.itemType = 'file';
      file.parentId = parentId;
      await file.save();
    } else {
      file = await File.create({
        userId,
        projectId: targetProject._id,
        name: fileName || 'untitled.js',
        itemType: 'file',
        parentId,
        sortOrder: await getNextSortOrder({ userId, projectId: targetProject._id, parentId }),
        content: code || '',
        language: language || 'javascript',
      });
    }

    await createVersionSnapshot({
      userId,
      projectId: targetProject._id,
      fileId: file._id,
      content: file.content,
      language: file.language,
      source: 'manual',
    });

    return res.status(200).json({ success: true, file, project: targetProject });
  } catch (error) {
    return next(error);
  }
};

exports.autoSaveFile = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { fileId, projectId, fileName, code, language } = req.body;

    if (!fileId && !fileName) {
      return res.status(400).json({ success: false, error: 'fileId or fileName is required' });
    }

    const targetProject = projectId
      ? await Project.findOne({ _id: projectId, userId })
      : await getDefaultProject(userId);

    if (!targetProject) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    let file = null;

    if (fileId) {
      file = await File.findOne({ _id: fileId, userId, projectId: targetProject._id });
    }

    if (!file && fileName) {
      file = await File.findOne({
        userId,
        projectId: targetProject._id,
        name: fileName,
        itemType: 'file',
      });
    }

    if (!file) {
      file = await File.create({
        userId,
        projectId: targetProject._id,
        name: fileName || 'untitled.js',
        itemType: 'file',
        parentId: null,
        sortOrder: await getNextSortOrder({ userId, projectId: targetProject._id, parentId: null }),
        content: code || '',
        language: language || 'javascript',
      });

      const snapshot = await createVersionSnapshot({
        userId,
        projectId: targetProject._id,
        fileId: file._id,
        content: file.content,
        language: file.language,
        source: 'autosave',
      });

      return res.status(201).json({
        success: true,
        file,
        project: targetProject,
        autoSaved: true,
        skipped: false,
        version: snapshot.version || null,
      });
    }

    const incomingContent = String(code ?? '');
    const incomingLanguage = language || file.language;

    const contentChanged = incomingContent !== String(file.content || '');
    const languageChanged = incomingLanguage !== file.language;
    const nameChanged = fileName && fileName !== file.name;

    if (!contentChanged && !languageChanged && !nameChanged) {
      return res.status(200).json({
        success: true,
        file,
        project: targetProject,
        autoSaved: false,
        skipped: true,
        reason: 'No content changes',
      });
    }

    file.content = incomingContent;
    file.language = incomingLanguage;
    if (nameChanged) {
      file.name = fileName;
    }
    await file.save();

    const snapshot = await createVersionSnapshot({
      userId,
      projectId: targetProject._id,
      fileId: file._id,
      content: file.content,
      language: file.language,
      source: 'autosave',
    });

    return res.status(200).json({
      success: true,
      file,
      project: targetProject,
      autoSaved: snapshot.created,
      skipped: !snapshot.created,
      reason: snapshot.created ? null : 'Duplicate version skipped',
      version: snapshot.version || snapshot.latestVersion || null,
    });
  } catch (error) {
    return next(error);
  }
};

exports.loadFile = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { fileId } = req.params;

    const file = await File.findOne({ _id: fileId, userId, itemType: 'file' }).lean();
    if (!file) {
      return res.status(404).json({ success: false, error: 'File not found' });
    }

    return res.status(200).json({ success: true, file });
  } catch (error) {
    return next(error);
  }
};

exports.listFiles = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { projectId } = req.query;

    const filter = { userId };
    if (projectId) {
      filter.projectId = projectId;
    }

    const files = await File.find(filter)
      .sort({ sortOrder: 1, itemType: 1, name: 1, updatedAt: -1 })
      .lean();

    return res.status(200).json({ success: true, files });
  } catch (error) {
    return next(error);
  }
};

exports.listFileTree = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { projectId } = req.query;

    if (!projectId) {
      return res.status(400).json({ success: false, error: 'projectId is required' });
    }

    const files = await File.find({ userId, projectId })
      .sort({ sortOrder: 1, itemType: 1, name: 1, updatedAt: -1 })
      .lean();

    const map = new Map();
    const roots = [];

    files.forEach((item) => {
      map.set(String(item._id), { ...item, children: [] });
    });

    map.forEach((node) => {
      const parentKey = node.parentId ? String(node.parentId) : null;
      if (parentKey && map.has(parentKey)) {
        map.get(parentKey).children.push(node);
      } else {
        roots.push(node);
      }
    });

    const sortNodes = (nodes) => {
      nodes.sort((a, b) => {
        if ((a.itemType || 'file') !== (b.itemType || 'file')) {
          return (a.itemType || 'file') === 'folder' ? -1 : 1;
        }
        if (Number.isFinite(a.sortOrder) && Number.isFinite(b.sortOrder) && a.sortOrder !== b.sortOrder) {
          return a.sortOrder - b.sortOrder;
        }
        return String(a.name || '').localeCompare(String(b.name || ''));
      });
      nodes.forEach((node) => sortNodes(node.children));
    };

    sortNodes(roots);

    return res.status(200).json({ success: true, tree: roots });
  } catch (error) {
    return next(error);
  }
};

exports.deleteFile = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { fileId } = req.params;

    const file = await File.findOne({ _id: fileId, userId });
    if (!file) {
      return res.status(404).json({ success: false, error: 'File not found' });
    }

    if (file.itemType === 'folder') {
      const deleteQueue = [file._id];
      while (deleteQueue.length > 0) {
        const currentId = deleteQueue.shift();
        const children = await File.find({ userId, parentId: currentId }).select('_id').lean();
        children.forEach((child) => deleteQueue.push(child._id));
        await File.deleteOne({ _id: currentId, userId });
        await FileVersion.deleteMany({ userId, fileId: currentId });
      }
      return res.status(200).json({ success: true, message: 'Folder deleted successfully' });
    }

    await File.deleteOne({ _id: fileId, userId });
    await FileVersion.deleteMany({ userId, fileId });

    return res.status(200).json({ success: true, message: 'File deleted successfully' });
  } catch (error) {
    return next(error);
  }
};

exports.createFile = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { projectId, name, type, parentId = null, language, content } = req.body || {};

    console.log('[api] POST /code/file req.body', {
      userId,
      projectId,
      name,
      type,
      parentId,
      language,
      contentLength: String(content || '').length,
    });

    if (type && String(type).toLowerCase() !== 'file') {
      return res.status(400).json({ success: false, error: 'type must be "file" for this endpoint' });
    }

    const normalizedName = String(name || '').trim();
    if (!normalizedName) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }

    const targetProject = await resolveTargetProject(userId, projectId);
    if (!targetProject) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const parentValidation = await assertValidParentFolder({
      userId,
      projectId: targetProject._id,
      parentId,
    });
    if (parentValidation) {
      return res.status(parentValidation.status).json({ success: false, error: parentValidation.error });
    }

    const file = await File.create({
      userId,
      projectId: targetProject._id,
      name: normalizedName,
      itemType: 'file',
      parentId,
      sortOrder: await getNextSortOrder({ userId, projectId: targetProject._id, parentId }),
      language: String(language || 'javascript').trim() || 'javascript',
      content: String(content || ''),
    });

    await createVersionSnapshot({
      userId,
      projectId: targetProject._id,
      fileId: file._id,
      content: file.content,
      language: file.language,
      source: 'manual',
    });

    console.log('[api] POST /code/file created', {
      fileId: String(file._id),
      projectId: String(targetProject._id),
      parentId: file.parentId ? String(file.parentId) : null,
      name: file.name,
      itemType: file.itemType,
    });

    return res.status(201).json({ success: true, file, project: targetProject });
  } catch (error) {
    return next(error);
  }
};

exports.createFolder = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { projectId, name, type, parentId = null } = req.body || {};

    console.log('[api] POST /code/folder req.body', {
      userId,
      projectId,
      name,
      type,
      parentId,
    });

    if (type && String(type).toLowerCase() !== 'folder') {
      return res.status(400).json({ success: false, error: 'type must be "folder" for this endpoint' });
    }

    const normalizedName = String(name || '').trim();
    if (!normalizedName) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }

    const targetProject = await resolveTargetProject(userId, projectId);

    if (!targetProject) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const parentValidation = await assertValidParentFolder({
      userId,
      projectId: targetProject._id,
      parentId,
    });
    if (parentValidation) {
      return res.status(parentValidation.status).json({ success: false, error: parentValidation.error });
    }

    const folder = await File.create({
      userId,
      projectId: targetProject._id,
      name: normalizedName,
      itemType: 'folder',
      parentId,
      sortOrder: await getNextSortOrder({ userId, projectId: targetProject._id, parentId }),
      language: 'folder',
      content: '',
    });

    console.log('[api] POST /code/folder created', {
      folderId: String(folder._id),
      projectId: String(targetProject._id),
      parentId: folder.parentId ? String(folder.parentId) : null,
      name: folder.name,
      itemType: folder.itemType,
    });

    return res.status(201).json({ success: true, file: folder });
  } catch (error) {
    return next(error);
  }
};

exports.renameNode = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { fileId } = req.params;
    const { name } = req.body;

    const file = await File.findOne({ _id: fileId, userId });
    if (!file) {
      return res.status(404).json({ success: false, error: 'Node not found' });
    }

    file.name = (name || file.name).trim();
    await file.save();
    return res.status(200).json({ success: true, file });
  } catch (error) {
    return next(error);
  }
};

exports.moveNode = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { fileId } = req.params;
    const { parentId = null, targetIndex } = req.body;

    const file = await File.findOne({ _id: fileId, userId });
    if (!file) {
      return res.status(404).json({ success: false, error: 'Node not found' });
    }

    await reorderSiblings({
      userId,
      projectId: file.projectId,
      parentId,
      movedFileId: file._id,
      targetIndex: Number.isFinite(Number(targetIndex)) ? Number(targetIndex) : undefined,
    });

    const updatedFile = await File.findOne({ _id: fileId, userId });

    return res.status(200).json({ success: true, file: updatedFile });
  } catch (error) {
    return next(error);
  }
};

exports.ensureDefaultProject = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const project = await getDefaultProject(userId);
    return res.status(200).json({ success: true, project });
  } catch (error) {
    return next(error);
  }
};

exports.listFileVersions = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { fileId } = req.params;
    const { limit = 50 } = req.query;

    const file = await File.findOne({ _id: fileId, userId, itemType: 'file' }).select('_id projectId').lean();
    if (!file) {
      return res.status(404).json({ success: false, error: 'File not found' });
    }

    const cappedLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 200));

    const versions = await FileVersion.find({ userId, fileId: file._id })
      .sort({ versionNumber: -1, createdAt: -1 })
      .limit(cappedLimit)
      .select('_id versionNumber language contentHash source createdAt')
      .lean();

    return res.status(200).json({ success: true, versions });
  } catch (error) {
    return next(error);
  }
};

exports.restoreFileVersion = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { fileId, versionId } = req.params;

    const file = await File.findOne({ _id: fileId, userId, itemType: 'file' });
    if (!file) {
      return res.status(404).json({ success: false, error: 'File not found' });
    }

    const version = await FileVersion.findOne({
      _id: versionId,
      userId,
      fileId: file._id,
    });

    if (!version) {
      return res.status(404).json({ success: false, error: 'Version not found' });
    }

    file.content = String(version.content || '');
    file.language = version.language || file.language;
    await file.save();

    const snapshot = await createVersionSnapshot({
      userId,
      projectId: file.projectId,
      fileId: file._id,
      content: file.content,
      language: file.language,
      source: 'restore',
      force: true,
    });

    return res.status(200).json({
      success: true,
      file,
      restoredFrom: {
        versionId: version._id,
        versionNumber: version.versionNumber,
      },
      version: snapshot.version || null,
    });
  } catch (error) {
    return next(error);
  }
};

exports.searchFiles = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { projectId, q = '', limit = 30 } = req.query;
    const query = String(q || '').trim();

    if (query.length < 1) {
      return res.status(200).json({ success: true, results: [] });
    }

    const cappedLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 30, 100));

    const filter = {
      userId,
      itemType: 'file',
      name: { $regex: query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' },
    };

    if (projectId) {
      filter.projectId = projectId;
    }

    const files = await File.find(filter)
      .sort({ updatedAt: -1, name: 1 })
      .limit(cappedLimit)
      .select('_id name language projectId parentId updatedAt')
      .lean();

    return res.status(200).json({ success: true, results: files });
  } catch (error) {
    return next(error);
  }
};
