import React, { useEffect, useMemo, useRef, useState } from 'react';
import TreeNode from './TreeNode';
import ContextMenu from './ContextMenu';

const filterTree = (nodes, query) => {
  if (!query) {
    return nodes;
  }

  const lowered = query.toLowerCase();
  return nodes
    .map((node) => {
      const children = filterTree(node.children || [], query);
      const selfMatch = String(node.name || '').toLowerCase().includes(lowered);
      if (selfMatch || children.length > 0) {
        return { ...node, children };
      }
      return null;
    })
    .filter(Boolean);
};

const flattenVisibleNodes = (nodes, expandedSet, depth = 0, parentId = null, list = []) => {
  nodes.forEach((node, index) => {
    list.push({ node, depth, parentId, siblingIndex: index });
    const isFolder = (node.itemType || 'file') === 'folder';
    if (isFolder && expandedSet.has(String(node._id))) {
      flattenVisibleNodes(node.children || [], expandedSet, depth + 1, String(node._id), list);
    }
  });
  return list;
};

export default function FileExplorer({
  treeData,
  activeFileId,
  highlightedNodeId,
  isReadOnly,
  onOpenFile,
  onNewFile,
  onNewFolder,
  onRename,
  onDelete,
  onMoveNode,
  onCopyPath,
}) {
  const [expandedFolders, setExpandedFolders] = useState(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [focusedNodeId, setFocusedNodeId] = useState(null);
  const [draggedNodeId, setDraggedNodeId] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [inlineAction, setInlineAction] = useState(null);
  const [inlineName, setInlineName] = useState('');
  const inlineInputRef = useRef(null);

  const filteredTree = useMemo(() => filterTree(treeData || [], searchQuery), [treeData, searchQuery]);

  const visibleNodes = useMemo(
    () => flattenVisibleNodes(filteredTree, expandedFolders),
    [filteredTree, expandedFolders]
  );

  const nodeById = useMemo(() => {
    const map = new Map();
    const addNode = (nodes, parentPath = '') => {
      nodes.forEach((node) => {
        const currentPath = parentPath ? `${parentPath}/${node.name}` : node.name;
        map.set(String(node._id), { ...node, path: currentPath });
        addNode(node.children || [], currentPath);
      });
    };
    addNode(treeData || []);
    return map;
  }, [treeData]);

  useEffect(() => {
    if (inlineAction) {
      inlineInputRef.current?.focus();
      inlineInputRef.current?.select();
    }
  }, [inlineAction]);

  const resolveParentFromFocus = () => {
    const focusedNode = focusedNodeId ? nodeById.get(String(focusedNodeId)) : null;
    if (!focusedNode) {
      return null;
    }

    if ((focusedNode.itemType || 'file') === 'folder') {
      return focusedNode._id;
    }

    return focusedNode.parentId || null;
  };

  const startInlineCreate = (kind, parentId = null) => {
    if (isReadOnly) {
      return;
    }

    const resolvedParentId = parentId === undefined ? resolveParentFromFocus() : parentId;
    const defaultName = kind === 'folder' ? 'New Folder' : 'new-file.js';
    console.log('[explorer action] start create', { kind, parentId: resolvedParentId });
    setInlineAction({ mode: 'create', kind, parentId: resolvedParentId || null });
    setInlineName(defaultName);
    setContextMenu(null);
  };

  const startInlineRename = (node) => {
    if (isReadOnly || !node?._id) {
      return;
    }

    console.log('[explorer action] start rename', { nodeId: node._id, name: node.name });
    setInlineAction({ mode: 'rename', node });
    setInlineName(String(node.name || ''));
    setFocusedNodeId(node._id);
    setContextMenu(null);
  };

  const cancelInlineAction = () => {
    setInlineAction(null);
    setInlineName('');
  };

  const commitInlineAction = async () => {
    const nextName = String(inlineName || '').trim();
    if (!inlineAction || !nextName) {
      cancelInlineAction();
      return;
    }

    if (inlineAction.mode === 'create') {
      console.log('[explorer action] create submit', {
        kind: inlineAction.kind,
        parentId: inlineAction.parentId,
        name: nextName,
      });

      const created = inlineAction.kind === 'folder'
        ? await onNewFolder(inlineAction.parentId, nextName)
        : await onNewFile(inlineAction.parentId, nextName);

      if (created?._id) {
        setFocusedNodeId(created._id);
      }
      cancelInlineAction();
      return;
    }

    if (inlineAction.mode === 'rename') {
      console.log('[explorer action] rename submit', {
        nodeId: inlineAction.node?._id,
        name: nextName,
      });

      const renamed = await onRename(inlineAction.node, nextName);
      if (renamed?._id) {
        setFocusedNodeId(renamed._id);
      }
      cancelInlineAction();
    }
  };

  const toggleFolder = (folderId) => {
    setExpandedFolders((previous) => {
      const next = new Set(previous);
      const key = String(folderId);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const handleDropNode = async (targetParentId, targetIndex) => {
    if (!draggedNodeId) {
      return;
    }

    if (String(draggedNodeId) === String(targetParentId || '')) {
      return;
    }

    let cursor = targetParentId ? String(targetParentId) : null;
    while (cursor) {
      if (cursor === String(draggedNodeId)) {
        return;
      }
      const nextNode = nodeById.get(cursor);
      cursor = nextNode?.parentId ? String(nextNode.parentId) : null;
    }

    await onMoveNode(draggedNodeId, targetParentId, targetIndex);
    setDraggedNodeId(null);
  };

  const handleKeyDown = async (event) => {
    if (!visibleNodes.length) {
      return;
    }

    const currentIndex = Math.max(0, visibleNodes.findIndex((item) => String(item.node._id) === String(focusedNodeId)));

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = visibleNodes[Math.min(currentIndex + 1, visibleNodes.length - 1)];
      setFocusedNodeId(next.node._id);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      const next = visibleNodes[Math.max(currentIndex - 1, 0)];
      setFocusedNodeId(next.node._id);
      return;
    }

    const current = visibleNodes[currentIndex];
    if (!current) {
      return;
    }

    const isFolder = (current.node.itemType || 'file') === 'folder';

    if (event.key === 'ArrowRight' && isFolder) {
      event.preventDefault();
      setExpandedFolders((previous) => {
        const next = new Set(previous);
        next.add(String(current.node._id));
        return next;
      });
      return;
    }

    if (event.key === 'ArrowLeft' && isFolder) {
      event.preventDefault();
      setExpandedFolders((previous) => {
        const next = new Set(previous);
        next.delete(String(current.node._id));
        return next;
      });
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      if (isFolder) {
        toggleFolder(current.node._id);
      } else {
        await onOpenFile(current.node._id);
      }
    }
  };

  return (
    <div className="explorer-root">
      <div className="explorer-actions" role="toolbar" aria-label="Explorer actions">
        <button
          type="button"
          className="explorer-action-btn"
          onClick={() => {
            console.log('[explorer button] new file');
            startInlineCreate('file', undefined);
          }}
          disabled={isReadOnly}
        >
          + File
        </button>
        <button
          type="button"
          className="explorer-action-btn"
          onClick={() => {
            console.log('[explorer button] new folder');
            startInlineCreate('folder', undefined);
          }}
          disabled={isReadOnly}
        >
          + Folder
        </button>
      </div>

      <input
        type="text"
        className="explorer-search"
        placeholder="Search files..."
        value={searchQuery}
        onChange={(event) => setSearchQuery(event.target.value)}
      />

      {inlineAction && (
        <div className="explorer-inline-editor">
          <input
            ref={inlineInputRef}
            type="text"
            className="explorer-inline-input"
            value={inlineName}
            onChange={(event) => setInlineName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitInlineAction();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                cancelInlineAction();
              }
            }}
            placeholder={inlineAction.mode === 'rename' ? 'Rename item' : 'Enter name'}
          />
          <button type="button" className="explorer-inline-btn" onClick={commitInlineAction}>OK</button>
          <button type="button" className="explorer-inline-btn explorer-inline-btn--ghost" onClick={cancelInlineAction}>Cancel</button>
        </div>
      )}

      <div className="explorer-tree" role="tree" tabIndex={0} onKeyDown={handleKeyDown}>
        {visibleNodes.map(({ node, depth, parentId, siblingIndex }) => {
          const isFolder = (node.itemType || 'file') === 'folder';
          const contextOptions = [
            {
              id: 'new-file',
              label: 'New File',
              onClick: () => startInlineCreate('file', isFolder ? node._id : parentId),
              disabled: isReadOnly,
            },
            {
              id: 'new-folder',
              label: 'New Folder',
              onClick: () => startInlineCreate('folder', isFolder ? node._id : parentId),
              disabled: isReadOnly,
            },
            {
              id: 'rename',
              label: 'Rename',
              onClick: () => startInlineRename(node),
              disabled: isReadOnly,
            },
            {
              id: 'delete',
              label: 'Delete',
              onClick: () => onDelete(node),
              disabled: isReadOnly,
            },
            {
              id: 'copy-path',
              label: 'Copy Path',
              onClick: () => onCopyPath(nodeById.get(String(node._id))?.path || node.name),
            },
          ];

          return (
            <TreeNode
              key={String(node._id)}
              node={node}
              depth={depth}
              parentId={parentId}
              siblingIndex={siblingIndex}
              isExpanded={expandedFolders.has(String(node._id))}
              isActive={String(node._id) === String(activeFileId)}
              isHighlighted={String(node._id) === String(highlightedNodeId || '')}
              isFocused={String(node._id) === String(focusedNodeId)}
              isReadOnly={isReadOnly}
              onToggleFolder={toggleFolder}
              onOpenFile={onOpenFile}
              onRequestContext={(event) => {
                setContextMenu({ x: event.clientX, y: event.clientY, options: contextOptions });
                setFocusedNodeId(node._id);
              }}
              onDragStart={setDraggedNodeId}
              onDropNode={handleDropNode}
              onFocusNode={setFocusedNodeId}
            />
          );
        })}
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          options={contextMenu.options}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
