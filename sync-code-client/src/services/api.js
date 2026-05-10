import axios from 'axios';

export const API_BASE_URL =
  process.env.REACT_APP_API_URL ||
  `${typeof window !== 'undefined' ? window.location.protocol : 'http:'}//${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}:5001/api`;

export const READ_ONLY_BLOCK_MESSAGE = 'Read-only mode enabled. Modification not allowed.';

export const getApiErrorMessage = (error, fallbackMessage = 'Request failed') => {
  return (
    error?.response?.data?.error ||
    error?.response?.data?.message ||
    error?.message ||
    fallbackMessage
  );
};

// Create axios instance with base configuration
const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add token to requests if available
apiClient.interceptors.request.use((config) => {
  const requestUrl = String(config.url || '');
  const isAuthRoute = requestUrl.startsWith('/auth/login')
    || requestUrl.startsWith('/auth/register')
    || requestUrl.startsWith('/auth/bootstrap-admin');

  // Never send stale bearer tokens when attempting a fresh auth action.
  if (isAuthRoute && config.headers?.Authorization) {
    delete config.headers.Authorization;
  }

  const token = localStorage.getItem('token');
  if (token && !isAuthRoute) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle response errors
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    // If token is invalid or expired, clear localStorage and redirect to login
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/';
    }
    return Promise.reject(error);
  }
);

// Authentication APIs
export const authAPI = {
  login: (email, password) =>
    apiClient.post('/auth/login', { email, password }),

  register: (name, email, password) =>
    apiClient.post('/auth/register', { name, email, password }),

  bootstrapAdmin: (email, token) =>
    apiClient.post('/auth/bootstrap-admin', { email, token }),

  listUsers: () => apiClient.get('/auth/users'),

  updateUserRole: (userId, role) =>
    apiClient.patch(`/auth/users/${userId}/role`, { role }),

  getProfile: () => apiClient.get('/auth/profile'),

  logout: async () => {
    try {
      // Optional: Call backend logout endpoint to invalidate token on server
      // await apiClient.post('/auth/logout');
    } catch (err) {
      console.error('Backend logout failed:', err);
      // Continue with frontend logout even if backend fails
    } finally {
      // Clear all authentication data from localStorage
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      localStorage.removeItem('syncCodeLastRoomId');
      
      // Remove authorization header from axios instance
      delete apiClient.defaults.headers.common['Authorization'];
      
      // Clear any cached data
      sessionStorage.clear();
    }
  },

  // Check if user is authenticated
  isAuthenticated: () => {
    const token = localStorage.getItem('token');
    return !!token;
  },

  // Get current user from localStorage
  getCurrentUser: () => {
    const userStr = localStorage.getItem('user');
    try {
      return userStr ? JSON.parse(userStr) : null;
    } catch (err) {
      console.error('Error parsing user data:', err);
      localStorage.removeItem('user');
      return null;
    }
  },
};

// Code APIs
export const codeAPI = {
  save: (payload) =>
    apiClient.post('/code/save', payload),

  run: (payload) =>
    apiClient.post('/run-code', payload),

  load: (fileId) =>
    apiClient.get(`/code/${fileId}`),

  list: (projectId) =>
    apiClient.get('/code/list', { params: projectId ? { projectId } : {} }),

  delete: (fileId) =>
    apiClient.delete(`/code/${fileId}`),
};

// Project APIs
export const projectAPI = {
  list: () => apiClient.get('/projects'),

  create: (name, description = '') =>
    apiClient.post('/projects', { name, description }),

  get: (projectId) => apiClient.get(`/projects/${projectId}`),

  getShared: (shareId) => apiClient.get(`/projects/shared/${shareId}`),

  update: (projectId, payload) => apiClient.put(`/projects/${projectId}`, payload),

  share: (projectId) => apiClient.post(`/projects/${projectId}/share`),

  remove: (projectId) => apiClient.delete(`/projects/${projectId}`),
};

// File APIs
export const fileAPI = {
  ensureDefaultProject: () => apiClient.get('/code/default-project'),

  search: (projectId, query, limit = 30) => apiClient.get('/code/search', {
    params: { projectId, q: query, limit },
  }),

  list: (projectId) => apiClient.get('/code/list', { params: projectId ? { projectId } : {} }),

  tree: (projectId) => apiClient.get('/code/tree', { params: { projectId } }),

  create: (projectId, payload) => apiClient.post('/code/save', { projectId, ...payload }),

  createFile: (projectId, payload) => apiClient.post('/code/file', { projectId, type: 'file', ...payload }),

  createFolder: (projectId, payload) => apiClient.post('/code/folder', { projectId, type: 'folder', ...payload }),

  renameNode: (fileId, name) => apiClient.patch(`/code/node/${fileId}`, { name }),

  moveNode: (fileId, payload) => apiClient.patch(`/code/move/${fileId}`, payload),

  save: (payload) => apiClient.post('/code/save', payload),

  autoSave: (payload) => apiClient.post('/code/autosave', payload),

  listVersions: (fileId, limit = 50) => apiClient.get(`/code/${fileId}/versions`, { params: { limit } }),

  restoreVersion: (fileId, versionId) => apiClient.post(`/code/${fileId}/versions/${versionId}/restore`),

  load: (fileId) => apiClient.get(`/code/${fileId}`),

  remove: (fileId) => apiClient.delete(`/code/${fileId}`),
};

// User APIs
export const userAPI = {
  getProfile: () =>
    apiClient.get('/user/profile'),

  updateProfile: (name, email) =>
    apiClient.put('/user/profile', { name, email }),

  changePassword: (oldPassword, newPassword) =>
    apiClient.post('/user/change-password', { oldPassword, newPassword }),
};

export const systemAPI = {
  getReadOnlyModeStatus: () => apiClient.get('/system/read-only'),
  setReadOnlyModeStatus: (readOnlyMode) => apiClient.patch('/system/read-only', { readOnlyMode }),
};

export const chatbotAPI = {
  reply: (params) => apiClient.get('/chatbot/reply', { params }),
};

export const terminalAPI = {
  execute: (command) => apiClient.post('/terminal/execute', { command }),
};

export default apiClient;
