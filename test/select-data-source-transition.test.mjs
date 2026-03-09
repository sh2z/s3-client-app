import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStatePatchForDataSourceSelection,
  isDataSourceSidebarActive,
} from '../src/state-transitions.mjs';

test('clicking data source from transfers switches back to objects page', () => {
  const next = buildStatePatchForDataSourceSelection({
    activePage: 'transfers',
    selectedSource: { id: 'source-1' },
  });

  assert.equal(next.activePage, 'objects');
  assert.equal(next.currentPath, '');
  assert.equal(next.searchQuery, '');
  assert.equal(next.bucketTotalSize, 0);
});

test('clicking data source from objects keeps objects page', () => {
  const next = buildStatePatchForDataSourceSelection({
    activePage: 'objects',
    selectedSource: { id: 'source-2' },
  });

  assert.equal(next.activePage, 'objects');
});

test('sidebar source highlight is disabled on transfers page', () => {
  assert.equal(
    isDataSourceSidebarActive({
      activePage: 'transfers',
      sourceId: 'source-1',
      selectedSourceId: 'source-1',
    }),
    false
  );
});

test('sidebar source highlight stays enabled on objects page for selected source', () => {
  assert.equal(
    isDataSourceSidebarActive({
      activePage: 'objects',
      sourceId: 'source-1',
      selectedSourceId: 'source-1',
    }),
    true
  );
});
