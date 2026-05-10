import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { authAPI } from '../services/api';

/**
 * useAuth Hook
 * Provides authentication utilities and state management
 * Usage: const { logout, isAuthenticated, user } = useAuth();
 */
export default function useAuth() {
  const navigate = useNavigate();

  const logout = useCallback(async (confirmIfUnsaved = false) => {
    try {
      // Optional: Show confirmation dialog
      if (confirmIfUnsaved) {
        const confirmed = window.confirm('Are you sure you want to logout?');
        if (!confirmed) {
          return false;
        }
      }

      // Clear authentication data
      authAPI.logout();
      
      // Redirect to login
      navigate('/');
      return true;
    } catch (err) {
      console.error('Logout error:', err);
      // Still redirect even if error occurs
      navigate('/');
      return false;
    }
  }, [navigate]);

  const isAuthenticated = useCallback(() => {
    return authAPI.isAuthenticated();
  }, []);

  const getCurrentUser = useCallback(() => {
    return authAPI.getCurrentUser();
  }, []);

  return {
    logout,
    isAuthenticated,
    getCurrentUser,
  };
}
