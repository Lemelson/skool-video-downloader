require('./load_env');
const path = require('path');
const { execFileSync } = require('child_process');

const scriptsDir = __dirname;
const targetUrl = process.argv[2] || process.env.SKOOL_CLASSROOM_URL;

if (!targetUrl) {
  console.error('Usage: npm run download:all <course-or-classroom-url>');
  console.error('  or set SKOOL_CLASSROOM_URL in .env');
  process.exit(1);
}

const rootDir = process.env.SKOOL_ARCHIVE_ROOT || process.cwd();
const stateFile = path.join(rootDir, 'course-state.json');

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit' });
}

function banner(text) {
  console.log(`\n==================================================`);
  console.log(text);
  console.log(`==================================================\n`);
}

try {
  banner(`[1/3] Fetching course structure for: ${targetUrl}`);
  run(process.execPath, [path.join(scriptsDir, 'cdp_course_state.js'), targetUrl]);

  banner(`[2/3] Downloading lesson details & attached resources (PDFs/notes)...`);
  run(process.execPath, [path.join(scriptsDir, 'cdp_download_lesson_details.js'), targetUrl]);

  banner(`[3/3] Downloading all course videos...`);
  // Pass the state file we just wrote so an older manifest/state file is never picked up instead.
  run(process.env.PYTHON || 'python3', [path.join(scriptsDir, 'download_accessible_videos.py'), stateFile]);

  banner(`[SUCCESS] All course materials & videos downloaded successfully!`);
} catch (err) {
  console.error(`\n[ERROR] An error occurred during download_all:`, err.message);
  process.exit(1);
}
