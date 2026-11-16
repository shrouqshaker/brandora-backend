// Source-only handoff archive. No Git mutation, private configuration or snapshots.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const archiver = require('archiver'); // Pinned by the existing npm lock through ExcelJS.

const FILES = [
  '.env.example',
  '.gitignore',
  'README.md',
  'app/local.py',
  'app/products_api.py',
  'app/data/search.py',
  'tests/test_local_runner.py',
  'docs/LOCAL_BACKEND_POSTMAN.md',
  'docs/HANDOFF.md',
  'docs/LEGACY_README.md',
  'docs/BRANDORA_AI_COMPLETE_WALKTHROUGH.md',
  'docs/BRANDORA_AI_TESTING_HANDBOOK.md',
];

function validateSelection(files) {
  if (
    !files.length ||
    new Set(files).size !== files.length ||
    files.some((f) => !FILES.includes(f))
  )
    throw new Error(
      'Only the reviewed source/documentation allowlist can be packaged',
    );
}

function checkContents(name, content) {
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content))
    throw new Error('Private key material cannot be packaged');
  if (name === '.env.example') {
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(
        /^(AI_SERVICE_TOKEN|BACKEND_SERVICE_TOKEN|BACKEND_CONTEXT_PUBLIC_KEY|GROQ_API_KEY|GEMINI_API_KEY|OPENROUTER_API_KEY|DEV_BACKEND_OWNER_TOKEN)=(.*)$/,
      );
      if (m && m[2].trim().replace(/^["']|["']$/g, '') !== '')
        throw new Error('Secret examples must remain empty');
    }
  }
}

async function packageHandoff(
  aiDir = path.resolve(__dirname, '..', '..', 'brandora-ai'),
  output = path.resolve(__dirname, '..', '.tmp', 'ai-handoff'),
) {
  aiDir = path.resolve(aiDir);
  output = path.resolve(output);
  validateSelection(FILES);
  const contents = FILES.map((file) => {
    const full = path.join(aiDir, file);
    if (!fs.lstatSync(full).isFile())
      throw new Error('Only ordinary source files are permitted');
    const bytes = fs.readFileSync(full);
    checkContents(file, bytes.toString('utf8'));
    return { file, bytes };
  });
  const baseline = execFileSync(
    'git',
    [
      '-c',
      'safe.directory=' + aiDir.replaceAll('\\', '/'),
      'rev-parse',
      'HEAD',
    ],
    { cwd: aiDir, encoding: 'utf8' },
  ).trim();
  const manifest = {
    repository: 'malkzidan/brandora-ai',
    baseline,
    state:
      'Uncommitted local files; review against recipient work before applying.',
    files: contents.map(({ file, bytes }) => ({
      file,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    })),
  };
  fs.mkdirSync(output, { recursive: true });
  const zip = path.join(
    output,
    'brandora-ai-handoff-' +
      new Date().toISOString().replace(/[:.]/g, '-') +
      '.zip',
  );
  const stream = fs.createWriteStream(zip, { flags: 'wx' });
  const archive = archiver('zip', { zlib: { level: 9 } });
  const closed = new Promise((resolve, reject) => {
    stream.on('close', resolve);
    stream.on('error', reject);
    archive.on('error', reject);
  });
  archive.pipe(stream);
  for (const item of contents) archive.append(item.bytes, { name: item.file });
  archive.append(JSON.stringify(manifest, null, 2) + '\n', {
    name: 'LOCAL_HANDOFF_MANIFEST.json',
  });
  await archive.finalize();
  await closed;
  return {
    archive: zip,
    sourceFiles: contents.length,
    sha256: crypto
      .createHash('sha256')
      .update(fs.readFileSync(zip))
      .digest('hex'),
  };
}
if (require.main === module) {
  packageHandoff(process.argv[2], process.argv[3])
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch(() => {
      console.error(
        'Source handoff packaging failed; check the guide, dependencies and reviewed files.',
      );
      process.exitCode = 1;
    });
}
module.exports = { packageHandoff, validateSelection, checkContents, FILES };
