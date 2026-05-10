import React, { useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import Register from './pages/Register';
import Editor from './pages/Editor';
import PrivateRoute from './components/PrivateRoute';
import PublicRoute from './components/PublicRoute';
import { API_BASE_URL } from './services/api';
import { useReadOnlyMode } from './context/ReadOnlyModeContext';
import './App.css';

function App() {
  const [backendStatus, setBackendStatus] = useState('checking');
  const { isReadOnlyMode } = useReadOnlyMode();

  useEffect(() => {
    const controller = new AbortController();

    const checkBackendHealth = async () => {
      const healthUrl = `${API_BASE_URL.replace(/\/$/, '')}/health`;

      try {
        const response = await fetch(healthUrl, {
          method: 'GET',
          signal: controller.signal,
        });
        setBackendStatus(response.ok ? 'online' : 'offline');
      } catch (error) {
        if (error.name !== 'AbortError') {
          setBackendStatus('offline');
        }
      }
    };

    checkBackendHealth();

    return () => {
      controller.abort();
    };
  }, []);

  const backendStatusLabel =
    backendStatus === 'online'
      ? 'Backend connected'
      : backendStatus === 'offline'
      ? 'Backend unreachable'
      : 'Checking backend...';

  return (
    <Router>
      {isReadOnlyMode && (
        <div className="read-only-banner" role="status" aria-live="polite">
          Read Only Mode Active
        </div>
      )}
      <div className={`app-health-status app-health-status--${backendStatus}`}>
        {backendStatusLabel}
      </div>
      <Routes>
        {/* Public routes - redirect to editor if already authenticated */}
        <Route
          path="/"
          element={
            <PublicRoute>
              <Login />
            </PublicRoute>
          }
        />
        <Route
          path="/register"
          element={
            <PublicRoute>
              <Register />
            </PublicRoute>
          }
        />

        {/* Protected routes - require valid JWT token */}
        <Route
          path="/editor"
          element={
            <PrivateRoute>
              <Editor />
            </PrivateRoute>
          }
        />

        {/* Catch all - redirect to login */}
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Router>
  );
}

export default App;
