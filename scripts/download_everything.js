require('./load_env');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const downloadAll = path.join(__dirname, 'download_all.js');

const classroomUrl = process.argv[2] || process.env.SKOOL_CLASSROOM_URL;

if (!classroomUrl) {
  console.error('Usage: npm run download:everything <classroom-url>');
  console.error('  or set SKOOL_CLASSROOM_URL in .env');
  process.exit(1);
}

try {
  console.log(`\n==================================================`);
  console.log(`[1/2] Fetching list of all courses in classroom: ${classroomUrl}`);
  console.log(`==================================================\n`);
  execFileSync(process.execPath, [path.join(__dirname, 'cdp_course_state.js'), classroomUrl], { stdio: 'inherit' });

  const rootDir = process.env.SKOOL_ARCHIVE_ROOT || process.cwd();
  const stateFile = path.join(rootDir, 'course-state.json');

  if (!fs.existsSync(stateFile)) {
    console.error(`State file not found at ${stateFile}`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const courses = data.filter(item => item.type === 'course' && item.url);

  if (courses.length === 0) {
    console.log(`[INFO] No multiple course list found, treating URL as a single course...`);
    execFileSync(process.execPath, [downloadAll, classroomUrl], { stdio: 'inherit' });
    process.exit(0);
  }

  console.log(`\nFound ${courses.length} courses to download.\n`);
  const failed = [];

  for (let i = 0; i < courses.length; i++) {
    const c = courses[i];
    console.log(`\n==================================================`);
    console.log(`[${i + 1}/${courses.length}] Processing Course: ${c.title}`);
    console.log(`URL: ${c.url}`);
    console.log(`==================================================\n`);

    try {
      execFileSync(process.execPath, [downloadAll, c.url], { stdio: 'inherit' });
    } catch (err) {
      console.error(`[ERROR] Failed to download course ${c.title}:`, err.message);
      failed.push(c.title);
    }
  }

  console.log(`\n==================================================`);
  if (failed.length) {
    console.log(`[DONE] ${courses.length - failed.length}/${courses.length} courses downloaded. Failed: ${failed.join(', ')}`);
  } else {
    console.log(`[SUCCESS] All courses in the classroom have been processed!`);
  }
  console.log(`==================================================\n`);
  if (failed.length) process.exit(1);
} catch (err) {
  console.error(`\n[ERROR] An error occurred during download:everything:`, err.message);
  process.exit(1);
}
