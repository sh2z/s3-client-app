export function buildStatePatchForDataSourceSelection({ activePage, selectedSource }) {
    return {
        activePage: activePage === 'transfers' ? 'objects' : activePage,
        selectedSource,
        currentPath: '',
        searchQuery: '',
        bucketTotalSize: 0,
    };
}

export function isDataSourceSidebarActive({ activePage, sourceId, selectedSourceId }) {
    return activePage === 'objects' && sourceId === selectedSourceId;
}
