import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { systemAPI } from '../services/api';

const ReadOnlyModeContext = createContext(null);

export function ReadOnlyModeProvider({ children }) {
  const [isReadOnlyMode, setIsReadOnlyMode] = useState(false);
  const [canToggleReadOnly, setCanToggleReadOnly] = useState(false);
  const [isLoadingReadOnlyMode, setIsLoadingReadOnlyMode] = useState(true);
  const [isTogglingReadOnlyMode, setIsTogglingReadOnlyMode] = useState(false);

  const refreshReadOnlyMode = useCallback(async () => {
    try {
      const response = await systemAPI.getReadOnlyModeStatus();
      setIsReadOnlyMode(Boolean(response?.data?.readOnlyMode));
      setCanToggleReadOnly(Boolean(response?.data?.canToggleReadOnly));
    } catch (error) {
      console.error('Unable to fetch read-only mode status:', error);
      setIsReadOnlyMode(false);
      setCanToggleReadOnly(false);
    } finally {
      setIsLoadingReadOnlyMode(false);
    }
  }, []);

  const toggleReadOnlyMode = useCallback(async (nextMode) => {
    setIsTogglingReadOnlyMode(true);
    try {
      const response = await systemAPI.setReadOnlyModeStatus(Boolean(nextMode));
      setIsReadOnlyMode(Boolean(response?.data?.readOnlyMode));
      return response?.data;
    } finally {
      setIsTogglingReadOnlyMode(false);
      await refreshReadOnlyMode();
    }
  }, [refreshReadOnlyMode]);

  useEffect(() => {
    refreshReadOnlyMode();
  }, [refreshReadOnlyMode]);

  const value = useMemo(() => ({
    isReadOnlyMode,
    canToggleReadOnly,
    isLoadingReadOnlyMode,
    isTogglingReadOnlyMode,
    refreshReadOnlyMode,
    toggleReadOnlyMode,
  }), [isReadOnlyMode, canToggleReadOnly, isLoadingReadOnlyMode, isTogglingReadOnlyMode, refreshReadOnlyMode, toggleReadOnlyMode]);

  return (
    <ReadOnlyModeContext.Provider value={value}>
      {children}
    </ReadOnlyModeContext.Provider>
  );
}

export function useReadOnlyMode() {
  const context = useContext(ReadOnlyModeContext);
  if (!context) {
    throw new Error('useReadOnlyMode must be used within a ReadOnlyModeProvider');
  }
  return context;
}
