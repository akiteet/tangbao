'use strict';
(function () {
  App.services = App.services || {};
  App.services.search = {
    query(input) {
      try {
        return (window.electron && window.electron.searchQuery)
          ? window.electron.searchQuery(input || {})
          : { ok: false, items: [], nextCursor: null, total: 0 };
      } catch (_) { return { ok: false, items: [], nextCursor: null, total: 0 }; }
    },
  };
})();
