const API_BASE = process.env.API_BASE || 'http://localhost:5001/api';
const PASSWORD = process.env.SMOKE_PASSWORD || 'Test@123456';

const requestJson = async (url, options = {}) => {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error || payload?.message || `Request failed: ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
};

const createAndVerifyUser = async (prefix) => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const email = `${prefix.toLowerCase()}_${suffix}@demo.local`;
  const name = `${prefix}_${suffix.slice(-4)}`;

  await requestJson(`${API_BASE}/auth/register`, {
    method: 'POST',
    body: JSON.stringify({ name, email, password: PASSWORD }),
  });

  const login = await requestJson(`${API_BASE}/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ email, password: PASSWORD }),
  });

  if (!login?.token || !login?.user?.id) {
    throw new Error(`${prefix}: login response missing token or user id`);
  }

  const profileResponse = await requestJson(`${API_BASE}/auth/profile`, {
    headers: {
      Authorization: `Bearer ${login.token}`,
    },
  });

  const profileUser = profileResponse?.user || profileResponse;

  const profileUserId = profileUser?.id || profileUser?._id;

  if (!profileUserId) {
    throw new Error(`${prefix}: profile response missing user id`);
  }

  const sameIdentity = String(login.user.id) === String(profileUserId) && login.user.name === profileUser.name;

  return {
    prefix,
    email,
    loginUserId: login.user.id,
    loginName: login.user.name,
    profileUserId,
    profileName: profileUser.name,
    tokenPresent: Boolean(login.token),
    sameIdentity,
  };
};

(async () => {
  try {
    console.log('[LOGIN_SMOKE] Starting login smoke test...');
    const [a, b] = await Promise.all([
      createAndVerifyUser('SmokeA'),
      createAndVerifyUser('SmokeB'),
    ]);

    const distinctUsers = a.loginUserId !== b.loginUserId;
    const pass = a.sameIdentity && b.sameIdentity && a.tokenPresent && b.tokenPresent && distinctUsers;

    console.log('[LOGIN_SMOKE] User A:', a);
    console.log('[LOGIN_SMOKE] User B:', b);

    if (!pass) {
      console.error('[LOGIN_SMOKE] RESULT: FAIL');
      process.exitCode = 1;
      return;
    }

    console.log('[LOGIN_SMOKE] RESULT: PASS');
  } catch (error) {
    console.error('[LOGIN_SMOKE] RESULT: FAIL', error.message);
    process.exitCode = 1;
  }
})();
