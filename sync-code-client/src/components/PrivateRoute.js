import React from 'react';
import { Navigate } from 'react-router-dom';
import { authAPI } from '../services/api';

/**
 * PrivateRoute Component
 * Protects routes that require authentication
 * If no valid token, redirects to login page
 */
export default function PrivateRoute({ children }) {
  const token = localStorage.getItem('token');

  // Token is the source of truth; profile hydration happens inside protected pages.
  if (!token) {
    // Clear any potentially corrupted data
    authAPI.logout();
    
    // Redirect to login
    return <Navigate to="/" replace />;
  }

  // User is authenticated, render the protected component
  return children;
}
