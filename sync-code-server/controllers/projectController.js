const Project = require('../models/Project');
const File = require('../models/File');
const crypto = require('crypto');

const getUserId = (req) => req.user.userId;

exports.listProjects = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const projects = await Project.find({ userId }).sort({ updatedAt: -1 }).lean();

    const countsByProject = await projects.reduce(async (promiseAccumulator, project) => {
      const accumulator = await promiseAccumulator;
      accumulator[String(project._id)] = await File.countDocuments({
        userId,
        projectId: project._id,
        itemType: 'file',
      });
      return accumulator;
    }, Promise.resolve({}));

    return res.status(200).json({
      success: true,
      projects: projects.map((project) => ({
        ...project,
        fileCount: countsByProject[String(project._id)] || 0,
      })),
    });
  } catch (error) {
    return next(error);
  }
};

exports.createProject = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { name, description = '' } = req.body;

    const project = await Project.create({
      userId,
      name: name?.trim() || 'Untitled Project',
      description: description.trim(),
    });

    return res.status(201).json({ success: true, project });
  } catch (error) {
    return next(error);
  }
};

exports.getProject = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { projectId } = req.params;

    const project = await Project.findOne({ _id: projectId, userId }).lean();
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const files = await File.find({ projectId, userId }).sort({ updatedAt: -1 }).lean();

    return res.status(200).json({ success: true, project: { ...project, files } });
  } catch (error) {
    return next(error);
  }
};

exports.updateProject = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { projectId } = req.params;
    const { name, description } = req.body;

    const project = await Project.findOneAndUpdate(
      { _id: projectId, userId },
      {
        ...(name !== undefined && { name: name.trim() || 'Untitled Project' }),
        ...(description !== undefined && { description: description.trim() }),
      },
      { new: true }
    );

    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    return res.status(200).json({ success: true, project });
  } catch (error) {
    return next(error);
  }
};

exports.deleteProject = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { projectId } = req.params;

    const project = await Project.findOneAndDelete({ _id: projectId, userId });
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    await File.deleteMany({ projectId, userId });

    return res.status(200).json({ success: true, message: 'Project deleted successfully' });
  } catch (error) {
    return next(error);
  }
};

exports.shareProject = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { projectId } = req.params;

    const project = await Project.findOne({ _id: projectId, userId });
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    if (!project.shareId) {
      project.shareId = crypto.randomBytes(8).toString('hex');
      await project.save();
    }

    const shareUrl = `${req.protocol}://${req.get('host')}/api/projects/shared/${project.shareId}`;
    return res.status(200).json({
      success: true,
      shareId: project.shareId,
      shareUrl,
      projectId: project._id,
    });
  } catch (error) {
    return next(error);
  }
};

exports.getSharedProject = async (req, res, next) => {
  try {
    const { shareId } = req.params;

    const project = await Project.findOne({ shareId }).lean();
    if (!project) {
      return res.status(404).json({ success: false, error: 'Shared project not found' });
    }

    const files = await File.find({ projectId: project._id, userId: project.userId })
      .sort({ updatedAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      project: {
        _id: project._id,
        name: project.name,
        description: project.description,
        shareId: project.shareId,
      },
      files,
    });
  } catch (error) {
    return next(error);
  }
};
