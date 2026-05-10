import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { authAPI, getApiErrorMessage, READ_ONLY_BLOCK_MESSAGE } from '../services/api';
import { useReadOnlyMode } from '../context/ReadOnlyModeContext';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { isReadOnlyMode } = useReadOnlyMode();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (isReadOnlyMode) {
      setError(READ_ONLY_BLOCK_MESSAGE);
      return;
    }

    setLoading(true);

    try {
      // Ensure fresh login is not contaminated by any previous session.
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      localStorage.removeItem('syncCodeLastRoomId');
      sessionStorage.clear();

      const response = await authAPI.login(email, password);
      localStorage.setItem('token', response.data.token);
      const profileResponse = await authAPI.getProfile();
      const profile = profileResponse?.data || {};
      const normalizedUser = {
        ...profile,
        id: profile.id || profile._id,
        _id: profile._id || profile.id,
      };
      localStorage.setItem('user', JSON.stringify(normalizedUser));
      await new Promise((resolve) => setTimeout(resolve, 300));
      navigate('/editor');
    } catch (err) {
      setError(getApiErrorMessage(err, 'Login failed. Please try again.'));
      console.error('Login error:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-container">
      <div className="auth-card">
        <h1>Sync Code</h1>
        <h2>Login</h2>

        {error && <div className="error-message">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              placeholder="your@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={loading || isReadOnlyMode}
            />
          </div>

          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={loading || isReadOnlyMode}
            />
          </div>

          <button type="submit" className="btn-primary" disabled={loading || isReadOnlyMode}>
            {loading ? 'Logging in...' : 'Login'}
          </button>
        </form>

        <p className="auth-link">
          Don't have an account? <Link to="/register">Register here</Link>
        </p>
      </div>
    </div>
  );
}
