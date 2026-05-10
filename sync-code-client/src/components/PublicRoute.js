import React from 'react';
import { Navigate } from 'react-router-dom';

/**
 * PublicRoute Component
 * Redirects authenticated users away from public pages (login, register)
 * If user has valid token, redirects to editor
 * Otherwise renders the public page
 */
export default function PublicRoute({ children }) {
  const token = localStorage.getItem('token');

  // Token is enough to consider the user authenticated.
  if (token) {
    return <Navigate to="/editor" replace />;
  }

  // User is not authenticated or data is invalid, render the public page
  return children;
}
