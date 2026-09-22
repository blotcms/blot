const path = require('path');
const Module = require('module');

process.env.NODE_PATH = [path.join(__dirname, '../../'), process.env.NODE_PATH || '']
  .filter(Boolean)
  .join(path.delimiter);
Module._initPaths();

const removeRoutePath = require.resolve('../site/folder/remove');

const resolveModulePath = (moduleName) => {
  try {
    return require.resolve(moduleName);
  } catch (err) {
    return require.resolve(path.join(__dirname, '../../', moduleName));
  }
};

const setModuleMock = (moduleName, exportsValue, touched) => {
  const resolved = resolveModulePath(moduleName);
  touched.push({ resolved, previous: require.cache[resolved] });
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
};

const setResolvedModuleMock = (resolvedPath, exportsValue, touched) => {
  touched.push({ resolved: resolvedPath, previous: require.cache[resolvedPath] });
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports: exportsValue,
  };
};

const restoreModuleMocks = (touched) => {
  touched.reverse().forEach(({ resolved, previous }) => {
    if (previous) {
      require.cache[resolved] = previous;
    } else {
      delete require.cache[resolved];
    }
  });
};

const createRes = () => {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };

  return res;
};

describe('dashboard folder remove route', function () {
  let touched;
  let fs;
  let establishSyncLock;
  let folderUpdate;
  let done;
  let folderIndexMock;

  beforeEach(function () {
    touched = [];
    folderUpdate = jasmine.createSpy('folder.update').and.returnValue(Promise.resolve());
    done = jasmine.createSpy('done').and.returnValue(Promise.resolve());

    fs = {
      pathExists: jasmine.createSpy('pathExists').and.returnValue(Promise.resolve(true)),
      remove: jasmine.createSpy('remove').and.returnValue(Promise.resolve()),
    };

    establishSyncLock = jasmine
      .createSpy('establishSyncLock')
      .and.returnValue(Promise.resolve({ folder: { update: folderUpdate }, done }));

    folderIndexMock = {
      invalidateCache: jasmine.createSpy('invalidateCache'),
    };

    setModuleMock('fs-extra', fs, touched);
    setModuleMock('clients', {}, touched);
    setModuleMock('sync/establishSyncLock', establishSyncLock, touched);
    setModuleMock(
      'helper/localPath',
      (blogID, relPath) => path.join('/blogs', String(blogID), relPath.replace(/^\/+/, '')),
      touched
    );
    setResolvedModuleMock(require.resolve('../site/folder/index'), folderIndexMock, touched);

    delete require.cache[removeRoutePath];
  });

  afterEach(function () {
    delete require.cache[removeRoutePath];
    restoreModuleMocks(touched);
  });

  it('returns 400 when path is missing', async function () {
    const handler = require('../site/folder/remove');
    const req = { params: {}, body: {}, blog: { id: 'blog-1' } };
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Missing path');
    expect(establishSyncLock).not.toHaveBeenCalled();
  });

  it('rejects absolute and path traversal attempts with 400', async function () {
    const handler = require('../site/folder/remove');

    const absoluteRes = createRes();
    await handler(
      { params: { path: '/etc/passwd' }, body: {}, blog: { id: 'blog-1' } },
      absoluteRes
    );

    expect(absoluteRes.statusCode).toBe(400);
    expect(absoluteRes.body.error).toBe('Absolute paths are not allowed');

    const traversalRes = createRes();
    await handler(
      { params: { path: '../../outside.txt' }, body: {}, blog: { id: 'blog-1' } },
      traversalRes
    );

    expect(traversalRes.statusCode).toBe(400);
    expect(traversalRes.body.error).toBe('Path escapes blog folder');
    expect(establishSyncLock).not.toHaveBeenCalled();
  });

  it('returns 404 when path is not found', async function () {
    fs.pathExists.and.returnValue(Promise.resolve(false));
    const handler = require('../site/folder/remove');
    const res = createRes();

    await handler(
      { params: { path: 'missing.txt' }, body: {}, blog: { id: 'blog-1' } },
      res
    );

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({
      ok: false,
      removed: 'missing.txt',
      error: 'Path not found',
    });
    expect(establishSyncLock).not.toHaveBeenCalled();
  });

  it('removes an existing local file and returns ok true', async function () {
    const handler = require('../site/folder/remove');
    const req = { params: { path: 'post.md' }, body: {}, blog: { id: 'blog-1', cacheID: 'c1' } };
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.removed).toBe('post.md');
    expect(fs.remove).toHaveBeenCalledWith('/blogs/blog-1/post.md');
    expect(folderUpdate).toHaveBeenCalledWith('/post.md');
    expect(folderIndexMock.invalidateCache).toHaveBeenCalledWith(req.blog);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('maps client and entry errors to 403, 400, and 502 responses', async function () {
    const clients = {
      mockClient: {
        remove: (blogID, relativePath, cb) => cb({ code: 'EACCES', message: 'denied' }),
      },
    };

    setModuleMock('clients', clients, touched);
    delete require.cache[removeRoutePath];
    let handler = require('../site/folder/remove');

    let res = createRes();
    await handler(
      { params: { path: 'locked.txt' }, body: {}, blog: { id: 'blog-1', client: 'mockClient' } },
      res
    );
    expect(res.statusCode).toBe(403);

    clients.mockClient.remove = (blogID, relativePath, cb) =>
      cb({ name: 'ValidationError', message: 'bad target' });

    delete require.cache[removeRoutePath];
    handler = require('../site/folder/remove');

    res = createRes();
    await handler(
      { params: { path: 'invalid.txt' }, body: {}, blog: { id: 'blog-1', client: 'mockClient' } },
      res
    );
    expect(res.statusCode).toBe(400);

    clients.mockClient.remove = (blogID, relativePath, cb) => cb(new Error('upstream failed'));

    delete require.cache[removeRoutePath];
    handler = require('../site/folder/remove');

    res = createRes();
    await handler(
      { params: { path: 'broken.txt' }, body: {}, blog: { id: 'blog-1', client: 'mockClient' } },
      res
    );
    expect(res.statusCode).toBe(502);
    expect(done.calls.count()).toBe(3);
  });

  it('returns 423 when the folder is locked by another sync', async function () {
    establishSyncLock.and.returnValue(
      Promise.reject(new Error('Failed to acquire folder lock'))
    );

    const handler = require('../site/folder/remove');
    const req = { params: { path: 'post.md' }, body: {}, blog: { id: 'blog-1' } };
    const res = createRes();
    res.headers = {};
    res.set = function (name, value) {
      this.headers[name] = value;
      return this;
    };

    await handler(req, res);

    expect(res.statusCode).toBe(423);
    expect(res.body).toEqual({
      ok: false,
      removed: null,
      error: 'Folder is locked by another sync; retry later',
    });
    expect(res.headers['Retry-After']).toBe('10');
  });
});
