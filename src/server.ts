import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { promises as fs } from 'fs';
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
const port = Number(process.env.PORT ?? 4000);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');
const publicDir = path.join(projectRoot, 'public');
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(projectRoot, 'data'));
const dataFile = path.join(dataDir, 'db.json');
const uploadDir = path.join(dataDir, 'uploads');
const organizerSetupKeyFile = path.join(dataDir, 'organizer-setup-key.txt');

const baseNews = [
  { id: 'news-1', title: 'Morning inspection', body: 'All camp teams are expected to report at 06:30 for inspection.', isPublished: true, createdAt: new Date().toISOString() },
  { id: 'news-2', title: 'Drill display update', body: 'The drill display will run at 10:00 in the main field.', isPublished: true, createdAt: new Date().toISOString() },
  { id: 'news-3', title: 'Awards planning', body: 'Final award ceremony will be held at 17:30 after all judging rounds.', isPublished: true, createdAt: new Date().toISOString() },
];
const baseAssessmentTemplates = [{
  id: 'project-2-trestle-building-v1',
  version: 1,
  title: 'Trestle Building',
  area: 'Project 2',
  category: 'Camp craft',
  description: 'Your patrol has been invited by the commissioner to demonstrate trestle building and its importance in day-to-day life.',
  criteria: [
    { id: 'lashings-knotting', question: 'Lashings & Knotting Technique', maxMarks: 24 },
    { id: 'stability-dimensions', question: 'Structural Stability & Dimensions', maxMarks: 16 },
    { id: 'safety-materials', question: 'Safety, Materials & Equipment Handling', maxMarks: 8 },
    { id: 'leadership-teamwork', question: 'Patrol Leadership & Teamwork', maxMarks: 8 },
    { id: 'speed-efficiency', question: 'Speed & Efficiency (Punctuality)', maxMarks: 4 },
  ],
  totalMarks: 60,
  active: true,
  createdAt: new Date().toISOString(),
}];

async function readDb() {
  try {
    const text = await fs.readFile(dataFile, 'utf-8');
    const parsed = JSON.parse(text);
    return {
      registrations: Array.isArray(parsed.registrations) ? parsed.registrations : [],
      assessments: Array.isArray(parsed.assessments) ? parsed.assessments : [],
      users: Array.isArray(parsed.users) ? parsed.users : [],
      areaImages: parsed.areaImages && typeof parsed.areaImages === 'object' ? parsed.areaImages : {},
      eventPhotos: Array.isArray(parsed.eventPhotos) ? parsed.eventPhotos : [],
      assessmentTemplates: Array.isArray(parsed.assessmentTemplates)
        ? parsed.assessmentTemplates
        : baseAssessmentTemplates.map((template) => ({ ...template, criteria: template.criteria.map((criterion) => ({ ...criterion })) })),
      news: Array.isArray(parsed.news) ? parsed.news : baseNews,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    const initial = {
      registrations: [],
      assessments: [],
      users: [],
      areaImages: {},
      eventPhotos: [],
      assessmentTemplates: baseAssessmentTemplates,
      news: baseNews,
    };
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(dataFile, JSON.stringify(initial, null, 2), 'utf-8');
    return initial;
  }
}

async function getOrganizerSetupKey() {
  if (process.env.ORGANIZER_SETUP_KEY) return process.env.ORGANIZER_SETUP_KEY;
  try {
    return (await fs.readFile(organizerSetupKeyFile, 'utf-8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const key = randomBytes(32).toString('base64url');
    await fs.mkdir(dataDir, { recursive: true });
    try {
      await fs.writeFile(organizerSetupKeyFile, key, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
      console.log(`Organizer setup key created at ${organizerSetupKeyFile}`);
      return key;
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
      return (await fs.readFile(organizerSetupKeyFile, 'utf-8')).trim();
    }
  }
}

async function writeDb(data: any) {
  await fs.mkdir(dataDir, { recursive: true });
  const temporaryFile = `${dataFile}.${process.pid}.tmp`;
  await fs.writeFile(temporaryFile, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(temporaryFile, dataFile);
}

let mutationQueue = Promise.resolve();

function updateDb<T>(update: (db: any) => T | Promise<T>): Promise<T> {
  const operation = mutationQueue.then(async () => {
    const db = await readDb();
    const result = await update(db);
    await writeDb(db);
    return result;
  });
  mutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

const competitionLevels = new Set([
  'Sub-County Inter-Patrol Competition',
  'County Inter-Patrol Competition',
]);
const subCounties = new Set([
  'Rachuonyo South', 'Kasipul', 'Ndhiwa', 'Mbita', 'Homa Bay Town', 'Rangwe',
  'Suba North', 'Suba South', 'Karachuonyo', 'Kabondo Kasipul', 'Rachuonyo East',
  'Rachuonyo North',
]);
const sections = new Set(['Sungura', 'Chipukizi', 'Mwamba', 'Jasiri']);
const categories = new Set(['Camp craft', 'Drills', 'Band']);
const genders = new Set(['Male', 'Female', 'Mixed']);
const assessmentAreas = [
  'Base 1', 'Base 2', 'Project 1', 'Project 2',
  'Arrival Inspection', 'Morning Inspection', 'Night Inspection',
];

function buildCategoryRankings(assessments: any[]) {
  return [...categories].map((category) => {
    const totals = new Map<string, {
      patrolCode: string;
      patrolName: string;
      schoolName: string;
      section: string;
      gender: string;
      scoreTotal: number;
      maxTotal: number;
      assessmentCount: number;
      rank: number;
    }>();
    for (const assessment of assessments.filter((item) => item.category === category)) {
      const ranking = totals.get(assessment.patrolCode) ?? {
        patrolCode: assessment.patrolCode,
        patrolName: assessment.patrolName,
        schoolName: assessment.schoolName,
        section: assessment.section,
        gender: assessment.gender,
        scoreTotal: 0,
        maxTotal: 0,
        assessmentCount: 0,
        rank: 0,
      };
      ranking.scoreTotal += Number(assessment.scoreTotal) || 0;
      ranking.maxTotal += Number(assessment.maxTotal) || 0;
      ranking.assessmentCount += 1;
      totals.set(assessment.patrolCode, ranking);
    }
    const entries = [...totals.values()]
      .sort((first, second) => second.scoreTotal - first.scoreTotal
        || first.patrolCode.localeCompare(second.patrolCode));
    let previousScore: number | null = null;
    let rank = 0;
    for (const [index, entry] of entries.entries()) {
      if (entry.scoreTotal !== previousScore) rank = index + 1;
      entry.rank = rank;
      previousScore = entry.scoreTotal;
    }
    return { category, patrols: entries };
  });
}

const sectionCode = (section: string) => {
  const map: Record<string, string> = {
    Sungura: 'S',
    Chipukizi: 'C',
    Mwamba: 'M',
    Jasiri: 'J',
  };
  const value = String(section ?? '').slice(0, 1).toUpperCase();
  return map[section] ?? (value || 'X');
};

const genderCode = (gender: string) => {
  const value = String(gender ?? '').toLowerCase();
  if (value.includes('female')) return 'G';
  if (value.includes('male')) return 'B';
  return 'M';
};

const categoryCode = (category: string) => {
  const value = String(category ?? '').toLowerCase();
  if (value.includes('drill')) return 'D';
  if (value.includes('band')) return 'B';
  return '';
};

function generatePatrolCode(db: any, input: { section: string; category: string; gender: string; specialNeeds: boolean }) {
  const genderPrefix = input.section === 'Jasiri' && input.gender === 'Male'
    && input.category === 'Drills' && input.specialNeeds
    ? 'M'
    : genderCode(input.gender);
  const prefix = `${sectionCode(input.section)}${genderPrefix}${categoryCode(input.category)}${input.specialNeeds ? 'S' : ''}`;
  const highest = (db.registrations as any[]).reduce((max, registration) => {
    const match = String(registration.patrolCode ?? '').match(new RegExp(`^${prefix}(\\d+)$`));
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `${prefix}${String(highest + 1).padStart(3, '0')}`;
}

app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(uploadDir));
app.use(express.static(publicDir));
app.set('trust proxy', 1);

type Session = { userId: string; authMethod: 'password' | 'accessCode'; expiresAt: number };
const sessions = new Map<string, Session>();
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const sessionCookieName = 'ksa_session';
const sessionLifetimeMs = 8 * 60 * 60 * 1000;
const passwordMinimumLength = 12;

function hashSecret(secret: string, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(secret, salt, 64).toString('hex') };
}

function verifySecret(secret: string, salt: string, expectedHash: string) {
  const actual = Buffer.from(hashSecret(secret, salt).hash, 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function getSessionToken(req: express.Request) {
  const cookies = req.headers.cookie?.split(';') ?? [];
  const sessionCookie = cookies.map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith(`${sessionCookieName}=`));
  return sessionCookie?.slice(sessionCookieName.length + 1);
}

async function getSessionUser(req: express.Request) {
  const token = getSessionToken(req);
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + sessionLifetimeMs;
  const db = await readDb();
  const user = db.users.find((item: any) => item.id === session.userId && item.active);
  if (!user) {
    sessions.delete(token);
    return null;
  }
  return user;
}

function setSessionCookie(res: express.Response, token: string) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${sessionCookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(sessionLifetimeMs / 1000)}${secure}`);
}

function clearSessionCookie(res: express.Response) {
  res.setHeader('Set-Cookie', `${sessionCookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function issueSession(res: express.Response, user: any, authMethod: Session['authMethod'] = 'password') {
  const token = randomBytes(32).toString('base64url');
  sessions.set(token, { userId: user.id, authMethod, expiresAt: Date.now() + sessionLifetimeMs });
  setSessionCookie(res, token);
}

function publicUser(user: any, authMethod: Session['authMethod'] = 'password') {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    hasPassword: Boolean(user.passwordHash),
    canChangePasswordWithoutCurrent: authMethod === 'accessCode',
  };
}

function allowRoles(...roles: string[]) {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      const user = await getSessionUser(req);
      if (!user || !roles.includes(user.role)) {
        return res.status(403).json({ message: 'Sign in with an authorized account to continue.' });
      }
      res.locals.user = user;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

function isLoginRateLimited(ipAddress: string) {
  const attempt = loginAttempts.get(ipAddress);
  if (!attempt || attempt.resetAt <= Date.now()) {
    loginAttempts.delete(ipAddress);
    return false;
  }
  return attempt.count >= 5;
}

function recordFailedLogin(ipAddress: string) {
  const now = Date.now();
  const attempt = loginAttempts.get(ipAddress);
  if (!attempt || attempt.resetAt <= now) {
    loginAttempts.set(ipAddress, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return;
  }
  attempt.count += 1;
}

const requireOrganizer = allowRoles('organizer');
const requireAssessor = allowRoles('assessor');
const requireSignedInUser = allowRoles('organizer', 'assessor');

app.get('/api/health', (_, res) => {
  res.json({
    ok: true,
    message: 'KSA Competition API is live',
    demoMode: process.env.DEMO_MODE === 'true',
  });
});

app.get('/api/auth/status', async (req, res) => {
  const db = await readDb();
  const user = await getSessionUser(req);
  const session = sessions.get(getSessionToken(req) || '');
  res.json({
    needsOrganizerSetup: !db.users.some((item: any) => item.role === 'organizer'),
    user: user ? publicUser(user, session?.authMethod) : null,
  });
});

app.post('/api/auth/setup-organizer', async (req, res) => {
  const setupKey = typeof req.body?.setupKey === 'string' ? req.body.setupKey : '';
  const expectedSetupKey = await getOrganizerSetupKey();
  const suppliedKeyBuffer = Buffer.from(setupKey);
  const expectedKeyBuffer = Buffer.from(expectedSetupKey);
  if (suppliedKeyBuffer.length !== expectedKeyBuffer.length
      || !timingSafeEqual(suppliedKeyBuffer, expectedKeyBuffer)) {
    return res.status(403).json({ message: 'The organizer setup key is missing or incorrect.' });
  }
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!name || !/^[a-z0-9._-]{3,40}$/.test(username) || password.length < passwordMinimumLength) {
    return res.status(400).json({ message: `Enter a name, username (3–40 letters, numbers, dots, dashes, or underscores), and password with at least ${passwordMinimumLength} characters.` });
  }
  const result = await updateDb((db) => {
    if (db.users.some((item: any) => item.role === 'organizer')) return { error: 'Organizer setup is already complete.', status: 409 };
    if (db.users.some((item: any) => item.username === username)) return { error: 'That username is already in use.', status: 409 };
    const credentials = hashSecret(password);
    const organizer = {
      id: crypto.randomUUID(), username, name, role: 'organizer',
      passwordSalt: credentials.salt, passwordHash: credentials.hash,
      accessCodeSalt: null, accessCodeHash: null, active: true, createdAt: new Date().toISOString(),
    };
    db.users.push(organizer);
    return { user: organizer };
  });
  if ('error' in result) return res.status(result.status ?? 500).json({ message: result.error });
  issueSession(res, result.user);
  res.status(201).json({ user: publicUser(result.user) });
});

app.post('/api/auth/login', async (req, res) => {
  const ipAddress = req.ip || 'unknown';
  if (isLoginRateLimited(ipAddress)) {
    return res.status(429).json({ message: 'Too many sign-in attempts. Wait 15 minutes before trying again.' });
  }
  const db = await readDb();
  let user: any;
  const accessCode = typeof req.body?.accessCode === 'string' ? req.body.accessCode.trim().toUpperCase() : '';
  if (accessCode) {
    user = db.users.find((item: any) =>
      item.active && item.role === 'assessor' && item.accessCodeSalt && item.accessCodeHash
      && verifySecret(accessCode, item.accessCodeSalt, item.accessCodeHash));
  } else {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    user = db.users.find((item: any) => item.active && item.username === username);
    if (!user?.passwordHash || !verifySecret(password, user.passwordSalt, user.passwordHash)) user = null;
  }
  if (!user) {
    recordFailedLogin(ipAddress);
    return res.status(401).json({ message: 'The sign-in details are not valid.' });
  }
  loginAttempts.delete(ipAddress);
  const authMethod = accessCode ? 'accessCode' : 'password';
  issueSession(res, user, authMethod);
  res.json({ user: publicUser(user, authMethod) });
});

app.post('/api/auth/logout', (req, res) => {
  const token = getSessionToken(req);
  if (token) sessions.delete(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.post('/api/auth/change-password', requireSignedInUser, async (req, res) => {
  const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
  const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
  if (newPassword.length < passwordMinimumLength) {
    return res.status(400).json({ message: `Password must have at least ${passwordMinimumLength} characters.` });
  }
  const userId = res.locals.user.id;
  const session = sessions.get(getSessionToken(req) || '');
  const result = await updateDb((db) => {
    const user = db.users.find((item: any) => item.id === userId && item.active);
    if (!user) return { error: 'Account not found.', status: 404 };
    if (user.passwordHash && session?.authMethod !== 'accessCode'
        && !verifySecret(currentPassword, user.passwordSalt, user.passwordHash)) {
      return { error: 'Current password is incorrect.', status: 400 };
    }
    const credentials = hashSecret(newPassword);
    user.passwordSalt = credentials.salt;
    user.passwordHash = credentials.hash;
    return { ok: true };
  });
  if ('error' in result) return res.status(result.status ?? 500).json({ message: result.error });
  if (session) session.authMethod = 'password';
  res.json({ ok: true });
});

app.get('/api/assessors', requireOrganizer, async (_, res) => {
  const db = await readDb();
  res.json(db.users.filter((item: any) => item.role === 'assessor').map((item: any) => ({
    id: item.id, username: item.username, name: item.name, active: item.active,
  })));
});

app.post('/api/assessors', requireOrganizer, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
  if (!name || !/^[a-z0-9._-]{3,40}$/.test(username)) {
    return res.status(400).json({ message: 'Enter a name and username (3–40 letters, numbers, dots, dashes, or underscores).' });
  }
  const accessCode = randomBytes(6).toString('hex').toUpperCase();
  const temporaryPassword = randomBytes(18).toString('base64url');
  const result = await updateDb((db) => {
    if (db.users.some((item: any) => item.username === username)) return { error: 'That username is already in use.', status: 409 };
    const accessCredentials = hashSecret(accessCode);
    const passwordCredentials = hashSecret(temporaryPassword);
    const assessor = {
      id: crypto.randomUUID(), username, name, role: 'assessor',
      passwordSalt: passwordCredentials.salt, passwordHash: passwordCredentials.hash,
      accessCodeSalt: accessCredentials.salt, accessCodeHash: accessCredentials.hash,
      active: true, createdAt: new Date().toISOString(),
    };
    db.users.push(assessor);
    return { assessor };
  });
  if ('error' in result) return res.status(result.status ?? 500).json({ message: result.error });
  res.status(201).json({
    assessor: { id: result.assessor.id, username, name },
    accessCode,
    temporaryPassword,
  });
});

app.post('/api/assessors/:id/rotate-code', requireOrganizer, async (req, res) => {
  const accessCode = randomBytes(6).toString('hex').toUpperCase();
  const result = await updateDb((db) => {
    const assessor = db.users.find((item: any) => item.id === String(req.params.id) && item.role === 'assessor' && item.active);
    if (!assessor) return { error: 'Active assessor account not found.', status: 404 };
    const credentials = hashSecret(accessCode);
    assessor.accessCodeSalt = credentials.salt;
    assessor.accessCodeHash = credentials.hash;
    return { id: assessor.id, username: assessor.username, name: assessor.name };
  });
  if ('error' in result) return res.status(result.status ?? 500).json({ message: result.error });
  for (const [token, session] of sessions) {
    if (session.userId === result.id) sessions.delete(token);
  }
  res.json({ assessor: result, accessCode });
});

app.patch('/api/assessors/:id', requireOrganizer, async (req, res) => {
  const result = await updateDb((db) => {
    const assessor = db.users.find((item: any) => item.id === String(req.params.id) && item.role === 'assessor');
    if (!assessor) return { error: 'Assessor account not found.', status: 404 };
    assessor.active = req.body?.active === true ? true : req.body?.active === false ? false : assessor.active;
    return { id: assessor.id, active: assessor.active };
  });
  if ('error' in result) return res.status(result.status ?? 500).json({ message: result.error });
  res.json(result);
});

app.get('/api/area-images', async (_, res) => {
  const db = await readDb();
  res.json(db.areaImages);
});

app.post('/api/area-images/:area', requireOrganizer, async (req, res) => {
  const area = String(req.params.area);
  if (!['registration', 'assessment'].includes(area)) {
    return res.status(400).json({ message: 'Choose a valid display area.' });
  }
  const match = typeof req.body?.image === 'string'
    ? req.body.image.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/)
    : null;
  if (!match) return res.status(400).json({ message: 'Choose a PNG, JPEG, or WebP image.' });
  const imageBuffer = Buffer.from(match[2], 'base64');
  if (!imageBuffer.length || imageBuffer.length > 1_000_000) {
    return res.status(400).json({ message: 'Images must be smaller than 1 MB.' });
  }
  const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
  const filename = `${area}.${extension}`;
  await fs.mkdir(uploadDir, { recursive: true });
  await fs.writeFile(path.join(uploadDir, filename), imageBuffer);
  const imageUrl = `/uploads/${filename}?v=${Date.now()}`;
  await updateDb((db) => { db.areaImages[area] = imageUrl; });
  res.json({ area, imageUrl });
});

app.get('/api/event-photos', async (_, res) => {
  const db = await readDb();
  res.json(db.eventPhotos);
});

app.post('/api/event-photos', requireOrganizer, async (req, res) => {
  const match = typeof req.body?.image === 'string'
    ? req.body.image.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/)
    : null;
  if (!match) return res.status(400).json({ message: 'Choose a PNG, JPEG, or WebP event photo.' });
  const imageBuffer = Buffer.from(match[2], 'base64');
  if (!imageBuffer.length || imageBuffer.length > 1_000_000) {
    return res.status(400).json({ message: 'Event photos must be smaller than 1 MB.' });
  }
  const caption = typeof req.body?.caption === 'string' ? req.body.caption.trim().slice(0, 160) : '';
  const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
  const id = crypto.randomUUID();
  const filename = `event-${id}.${extension}`;
  await fs.mkdir(uploadDir, { recursive: true });
  await fs.writeFile(path.join(uploadDir, filename), imageBuffer);
  const photo = {
    id,
    caption,
    imageUrl: `/uploads/${filename}`,
    uploadedAt: new Date().toISOString(),
  };
  await updateDb((db) => { db.eventPhotos.unshift(photo); });
  res.status(201).json(photo);
});

app.delete('/api/event-photos/:id', requireOrganizer, async (req, res) => {
  const result = await updateDb((db) => {
    const index = (db.eventPhotos as any[]).findIndex((photo) => photo.id === String(req.params.id));
    if (index < 0) return { error: 'Event photo not found.', status: 404 };
    const [photo] = db.eventPhotos.splice(index, 1);
    return { photo };
  });
  if ('error' in result) return res.status(result.status ?? 500).json({ message: result.error });
  const filename = path.basename(new URL(result.photo.imageUrl, 'http://localhost').pathname);
  await fs.rm(path.join(uploadDir, filename), { force: true });
  res.json({ ok: true });
});

app.get('/api/summary', async (_, res) => {
  const db = await readDb();
  const registrations = db.registrations || [];
  const assessments = db.assessments || [];
  const approved = registrations.filter((r: any) => r.registrationStatus === 'Approved').length;
  const paid = registrations.filter((r: any) => r.paymentStatus === 'Paid').length;

  res.json({
    registrations: registrations.length,
    scouts: registrations.reduce((total: number, registration: any) => total + Number(registration.membersCount || 0), 0),
    approved,
    paid,
    assessments: assessments.length,
    news: db.news || [],
  });
});

app.get('/api/registrations', requireOrganizer, async (_, res) => {
  const db = await readDb();
  res.json(db.registrations || []);
});

app.get('/api/public/patrols', async (_, res) => {
  const db = await readDb();
  const patrols = (db.registrations as any[])
    .filter((registration) => registration.patrolCode && registration.paymentStatus === 'Paid')
    .map((registration) => ({
      schoolName: registration.schoolName,
      patrolName: registration.patrolName,
      subCounty: registration.subCounty,
      section: registration.section,
      gender: registration.gender,
      category: registration.category,
      membersCount: registration.membersCount,
    }));
  res.json(patrols);
});

app.get('/api/patrol-code-preview', requireOrganizer, async (req, res) => {
  const { section, category, gender } = req.query;
  const specialNeeds = req.query.specialNeeds;
  if (typeof section !== 'string' || !sections.has(section)
      || typeof category !== 'string' || !categories.has(category)
      || typeof gender !== 'string' || !genders.has(gender)
      || (specialNeeds !== 'true' && specialNeeds !== 'false')) {
    return res.status(400).json({ message: 'Choose a valid section, category, gender, and special-needs status to preview the patrol code.' });
  }
  const db = await readDb();
  res.json({ patrolCode: generatePatrolCode(db, { section, category, gender, specialNeeds: specialNeeds === 'true' }) });
});

app.post('/api/registrations', requireOrganizer, async (req, res) => {
  const body = req.body ?? {};
  const required = [
    'competitionLevel', 'subCounty', 'schoolName', 'scoutLeader', 'scoutLeaderMembershipNo',
    'patrolName', 'section', 'category', 'gender',
  ];
  const missing = required.filter((key) => typeof body[key] !== 'string' || !body[key].trim());
  if (missing.length) {
    return res.status(400).json({ message: `Missing required fields: ${missing.join(', ')}` });
  }

  if (!competitionLevels.has(body.competitionLevel) || !subCounties.has(body.subCounty)
      || !sections.has(body.section) || !categories.has(body.category) || !genders.has(body.gender)) {
    return res.status(400).json({ message: 'Choose a valid competition level, sub-county, section, category, and patrol gender.' });
  }

  if (typeof body.specialNeeds !== 'boolean') {
    return res.status(400).json({ message: 'Special-needs status must be selected.' });
  }

  const assistantScoutLeader = typeof body.assistantScoutLeader === 'string'
    ? body.assistantScoutLeader.trim()
    : '';
  const assistantScoutLeaderMembershipNo = typeof body.assistantScoutLeaderMembershipNo === 'string'
    ? body.assistantScoutLeaderMembershipNo.trim()
    : '';
  if (assistantScoutLeader && !assistantScoutLeaderMembershipNo) {
    return res.status(400).json({ message: 'KSA membership number is required when an Assistant Scout Leader is entered.' });
  }

  const membersCount = Number(body.membersCount);
  if (!Number.isInteger(membersCount) || membersCount < 1 || membersCount > 100) {
    return res.status(400).json({ message: 'Number of patrol members must be a whole number from 1 to 100.' });
  }

  const emergencyContact = typeof body.emergencyContact === 'string' ? body.emergencyContact.trim() : '';

  const now = new Date().toISOString();
  const registration = await updateDb((db) => {
    const created = {
      id: crypto.randomUUID(),
      competitionLevel: body.competitionLevel,
      subCounty: body.subCounty,
      schoolName: body.schoolName.trim(),
      ksaUnitNo: typeof body.ksaUnitNo === 'string' && body.ksaUnitNo.trim() ? body.ksaUnitNo.trim() : null,
      scoutLeader: body.scoutLeader.trim(),
      scoutLeaderMembershipNo: body.scoutLeaderMembershipNo.trim(),
      assistantScoutLeader: assistantScoutLeader || null,
      assistantScoutLeaderMembershipNo: assistantScoutLeaderMembershipNo || null,
      patrolName: body.patrolName.trim(),
      patrolCode: generatePatrolCode(db, body),
      section: body.section,
      category: body.category,
      gender: body.gender,
      specialNeeds: body.specialNeeds,
      membersCount,
      arrivalTime: null,
      emergencyContact: emergencyContact || null,
      registrationStatus: 'Pending',
      paymentStatus: 'Pending',
      receiptNumber: null,
      createdAt: now,
      updatedAt: now,
    };
    db.registrations.unshift(created);
    return created;
  });
  res.status(201).json(registration);
});

app.post('/api/registrations/:id/approve-payment', requireOrganizer, async (req, res) => {
  const receiptNumber = typeof req.body?.receiptNumber === 'string' ? req.body.receiptNumber.trim() : '';
  if (!receiptNumber) {
    return res.status(400).json({ message: 'A verified payment receipt number is required.' });
  }

  const result = await updateDb((db) => {
    const registration = db.registrations.find((item: any) => item.id === req.params.id);
    if (!registration) return { error: 'Registration not found.', status: 404 };
    if (registration.paymentStatus === 'Paid') return { error: 'Payment has already been approved.', status: 409 };

    registration.paymentStatus = 'Paid';
    registration.registrationStatus = 'Approved';
    registration.receiptNumber = receiptNumber;
    registration.updatedAt = new Date().toISOString();
    return { registration };
  });

  if ('error' in result) return res.status(result.status ?? 500).json({ message: result.error });
  res.json(result.registration);
});

app.post('/api/registrations/:id/check-in', requireOrganizer, async (req, res) => {
  const result = await updateDb((db) => {
    const registration = db.registrations.find((item: any) => item.id === req.params.id);
    if (!registration) return { error: 'Registration not found.', status: 404 };
    if (!registration.patrolCode) return { error: 'Approve payment before checking in this patrol.', status: 409 };
    if (registration.registrationStatus === 'Checked-In') return { error: 'Patrol is already checked in.', status: 409 };
    registration.registrationStatus = 'Checked-In';
    registration.arrivalTime = new Date().toISOString();
    registration.updatedAt = registration.arrivalTime;
    return { registration };
  });

  if ('error' in result) return res.status(result.status ?? 500).json({ message: result.error });
  res.json(result.registration);
});

app.get('/api/assessment-patrols', requireAssessor, async (req, res) => {
  const area = typeof req.query.area === 'string' ? req.query.area : '';
  if (!assessmentAreas.includes(area)) {
    return res.status(400).json({ message: 'Choose a valid assessment area.' });
  }
  const db = await readDb();
  const alreadyAssessed = new Set((db.assessments as any[])
    .filter((assessment) => assessment.area === area)
    .map((assessment) => assessment.patrolCode));
  const patrols = (db.registrations as any[])
    .filter((registration) => registration.patrolCode && registration.paymentStatus === 'Paid')
    .map((registration) => ({
      patrolCode: registration.patrolCode,
      patrolName: registration.patrolName,
      section: registration.section,
      category: registration.category,
      gender: registration.gender,
      alreadyAssessed: alreadyAssessed.has(registration.patrolCode),
    }));
  res.json(patrols);
});

app.get('/api/assessment-templates', allowRoles('assessor', 'organizer'), async (req, res) => {
  const db = await readDb();
  const area = typeof req.query.area === 'string' ? req.query.area : '';
  const category = typeof req.query.category === 'string' ? req.query.category : '';
  const templates = (db.assessmentTemplates as any[])
    .filter((template) => template.active)
    .filter((template) => !area || template.area === area)
    .filter((template) => !category || template.category === category || template.category === 'All categories')
    .sort((a, b) => Number(b.category === category) - Number(a.category === category) || b.createdAt.localeCompare(a.createdAt));
  res.json(templates);
});

app.post('/api/assessment-templates', requireOrganizer, async (req, res) => {
  const body = req.body ?? {};
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const area = typeof body.area === 'string' ? body.area.trim() : '';
  const category = typeof body.category === 'string' ? body.category.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const criteria = body.criteria;
  if (!title || !area || !category || !Array.isArray(criteria) || criteria.length === 0) {
    return res.status(400).json({ message: 'Add a title, assessment area, category, and at least one scoring question.' });
  }
  if (!assessmentAreas.includes(area)
      || ![...categories, 'All categories'].includes(category)) {
    return res.status(400).json({ message: 'Choose a valid assessment area and competition category.' });
  }

  const normalizedCriteria: { id: string; question: string; maxMarks: number }[] = [];
  for (const [index, criterion] of criteria.entries()) {
    const question = typeof criterion?.question === 'string' ? criterion.question.trim() : '';
    const maxMarks = Number(criterion?.maxMarks);
    if (!question || !Number.isInteger(maxMarks) || maxMarks < 1 || maxMarks > 100) {
      return res.status(400).json({ message: `Question ${index + 1} needs text and a whole-number maximum from 1 to 100.` });
    }
    normalizedCriteria.push({ id: crypto.randomUUID(), question, maxMarks });
  }
  const totalMarks = normalizedCriteria.reduce((sum, criterion) => sum + criterion.maxMarks, 0);
  if (totalMarks > 500) {
    return res.status(400).json({ message: 'A rubric cannot exceed 500 total marks.' });
  }

  const template = await updateDb((db) => {
    const matchingVersions = (db.assessmentTemplates as any[])
      .filter((item) => item.area === area && item.category === category);
    for (const previous of matchingVersions) previous.active = false;
    const saved = {
      id: crypto.randomUUID(),
      version: matchingVersions.reduce((max, item) => Math.max(max, Number(item.version) || 0), 0) + 1,
      title,
      area,
      category,
      description,
      criteria: normalizedCriteria,
      totalMarks,
      active: true,
      createdAt: new Date().toISOString(),
    };
    db.assessmentTemplates.unshift(saved);
    return saved;
  });
  res.status(201).json(template);
});

app.get('/api/organizer/assessment-results', requireOrganizer, async (_, res) => {
  const db = await readDb();
  const registrations = new Map((db.registrations as any[])
    .map((registration) => [registration.patrolCode, registration]));
  const assessments = (db.assessments as any[])
    .map((assessment) => {
      const registration = registrations.get(assessment.patrolCode);
      return {
        id: assessment.id,
        patrolCode: assessment.patrolCode,
        patrolName: assessment.patrolName,
        schoolName: registration?.schoolName ?? 'Unknown institution',
        section: assessment.section,
        gender: assessment.gender,
        category: assessment.category,
        area: assessment.area,
        assessorName: assessment.assessorName,
        startingAt: assessment.startingAt,
        endingAt: assessment.endingAt,
        scoreTotal: assessment.scoreTotal,
        maxTotal: assessment.maxTotal,
        answers: assessment.answers,
        notes: assessment.notes,
      };
    })
    .sort((first, second) => second.endingAt.localeCompare(first.endingAt));

  res.json({ assessments, rankings: buildCategoryRankings(assessments) });
});

app.get('/api/public/leaderboard', async (_, res) => {
  const db = await readDb();
  const registrations = new Map((db.registrations as any[])
    .map((registration) => [registration.patrolCode, registration]));
  const assessments = (db.assessments as any[]).map((assessment) => ({
    patrolCode: assessment.patrolCode,
    patrolName: assessment.patrolName,
    schoolName: registrations.get(assessment.patrolCode)?.schoolName ?? 'Unknown institution',
    section: assessment.section,
    gender: assessment.gender,
    category: assessment.category,
    scoreTotal: assessment.scoreTotal,
    maxTotal: assessment.maxTotal,
  }));
  const rankings = buildCategoryRankings(assessments).map((group) => ({
    category: group.category,
    patrols: group.patrols.slice(0, 3),
  }));
  res.json(rankings);
});

app.post('/api/assessments', requireAssessor, async (req, res) => {
  const body = req.body ?? {};
  const patrolCode = String(body.patrolCode || '').trim();
  const assessorName = res.locals.user.name;
  const area = String(body.area || '').trim();
  const startingAt = typeof body.startingAt === 'string' ? new Date(body.startingAt) : new Date('');
  const assessorSignature = typeof body.assessorSignature === 'string' ? body.assessorSignature : '';
  if (!patrolCode || !assessorName || !area || Number.isNaN(startingAt.getTime())
      || !Array.isArray(body.answers) || body.answers.length === 0) {
    return res.status(400).json({ message: 'Assessment details are incomplete. Add the patrol, assessor, start time, and scored questions.' });
  }
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(assessorSignature)) {
    return res.status(400).json({ message: 'The assessor must sign before submission.' });
  }
  if (assessorSignature.length < 200 || assessorSignature.length > 200_000) {
    return res.status(400).json({ message: 'Signatures are too large. Clear the signature and sign again.' });
  }

  const result = await updateDb((db) => {
    const registration = db.registrations.find((item: any) => item.patrolCode === patrolCode);
    if (!registration || registration.paymentStatus !== 'Paid') {
      return { error: 'This patrol code is not registered for assessment.', status: 404 };
    }
    if (body.section !== registration.section || body.category !== registration.category || body.gender !== registration.gender) {
      return { error: 'Section, gender, and category must match the selected patrol registration.', status: 400 };
    }
    if (db.assessments.some((item: any) => item.patrolCode === patrolCode && item.area === area)) {
      return { error: 'This patrol already has an assessment saved for this area.', status: 409 };
    }
    const template = (db.assessmentTemplates as any[]).find((item) =>
      item.id === body.templateId && item.active && item.area === area
      && (item.category === registration.category || item.category === 'All categories'));
    if (!template) return { error: 'No active scoring rubric is configured for this patrol and assessment area.', status: 400 };

    const submittedAnswers = body.answers as any[];
    if (submittedAnswers.length !== template.criteria.length) {
      return { error: 'Score every question in the current rubric before submitting.', status: 400 };
    }
    const answers = [];
    for (const criterion of template.criteria) {
      const submitted = submittedAnswers.find((answer) => answer?.criterionId === criterion.id);
      const score = Number(submitted?.score);
      if (!submitted || !Number.isInteger(score) || score < 0 || score > criterion.maxMarks) {
        return { error: `Score for “${criterion.question}” must be between 0 and ${criterion.maxMarks}.`, status: 400 };
      }
      answers.push({
        criterionId: criterion.id,
        question: criterion.question,
        score,
        maxMarks: criterion.maxMarks,
      });
    }
    const totalScore = answers.reduce((sum, answer) => sum + answer.score, 0);
    const now = new Date();
    if (startingAt > now) return { error: 'Assessment start time cannot be in the future.', status: 400 };
    const assessment = {
      id: crypto.randomUUID(),
      patrolCode,
      patrolName: registration.patrolName,
      section: registration.section,
      category: registration.category,
      gender: registration.gender,
      area,
      templateId: template.id,
      templateVersion: template.version,
      templateTitle: template.title,
      startingAt: startingAt.toISOString(),
      endingAt: now.toISOString(),
      assessorName,
      assessorSignature,
      answers,
      scoreTotal: totalScore,
      maxTotal: template.totalMarks,
      notes: typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null,
      createdAt: now.toISOString(),
    };
    db.assessments.unshift(assessment);
    return { assessment };
  });
  if ('error' in result) return res.status(result.status ?? 500).json({ message: result.error });
  res.status(201).json(result.assessment);
});

app.get('/api/news', async (_, res) => {
  const db = await readDb();
  res.json(db.news || []);
});

app.post('/api/news', requireOrganizer, async (req, res) => {
  const body = req.body ?? {};
  const title = String(body.title || '').trim();
  const text = String(body.body || '').trim();

  if (!title || !text) {
    return res.status(400).json({ message: 'Title and body are required' });
  }

  const db = await readDb();
  const news = {
    id: crypto.randomUUID(),
    title,
    body: text,
    isPublished: body.isPublished !== false,
    createdAt: new Date().toISOString(),
  };

  db.news = [news, ...(db.news || [])];
  await writeDb(db);
  res.status(201).json(news);
});

app.use('/api', (_, res) => {
  res.status(404).json({ message: 'API endpoint not found.' });
});

app.use((_, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

async function start() {
  await readDb();
  await getOrganizerSetupKey();
  app.listen(port, '0.0.0.0', () => {
    console.log(`KSA Competition API is running on port ${port}`);
  });
}

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
