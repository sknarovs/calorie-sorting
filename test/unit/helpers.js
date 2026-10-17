function fakeStorage({ reject = () => false } = {}) {
  const data = new Map();
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => {
      if (reject(String(v))) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
      data.set(k, String(v));
    },
    removeItem: (k) => { data.delete(k); },
  };
}
module.exports = { fakeStorage };
