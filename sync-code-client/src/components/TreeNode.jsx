import React from 'react';

export default function TreeNode({
  node,
  depth,
  parentId,
  siblingIndex,
  isExpanded,
  isActive,
  isHighlighted,
  isFocused,
  isReadOnly,
  onToggleFolder,
  onOpenFile,
  onRequestContext,
  onDragStart,
  onDropNode, 
  onFocusNode,
}) {
  const isFolder = (node.itemType || 'file') === 'folder';

  return (
    <div className="explorer-node-wrap">
      <div
        role="treeitem"
        aria-expanded={isFolder ? isExpanded : undefined}
        aria-selected={isActive}
        tabIndex={isFocused ? 0 : -1}
        draggable={!isReadOnly}
        className={`explorer-node ${isActive ? 'explorer-node--active' : ''} ${isFocused ? 'explorer-node--focused' : ''} ${isHighlighted ? 'explorer-node--highlighted' : ''}`}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onFocus={() => onFocusNode(node._id)}
        onClick={() => {
          console.log(`[explorer click] ${node._id}`);
          if (isFolder) {
            onToggleFolder(node._id);
          } else {
            onOpenFile(node._id);
          }
        }}
        onDoubleClick={() => {
          if (!isFolder) {
            onOpenFile(node._id);
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onRequestContext(event, node);
        }}
        onDragStart={() => onDragStart(node._id)}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const targetParentId = isFolder ? node._id : parentId;
          const targetIndex = isFolder ? (node.children?.length || 0) : siblingIndex;
          onDropNode(targetParentId, targetIndex);
        }}
      >
        <button
          type="button"
          className="explorer-disclosure"
          aria-label={isFolder ? (isExpanded ? 'Collapse folder' : 'Expand folder') : 'File'}
          onClick={(event) => {
            event.stopPropagation();
            if (isFolder) {
              onToggleFolder(node._id);
            }
          }}
        >
          {isFolder ? (isExpanded ? '▾' : '▸') : '•'}
        </button>

        <span className="explorer-icon" aria-hidden="true">{isFolder ? (isExpanded ? '📂' : '📁') : '📄'}</span>
        <span className="explorer-name">{node.name}</span>
      </div>
    </div>
  );
}
