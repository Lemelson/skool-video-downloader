require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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
  execSync(`node -r dotenv/config scripts/cdp_course_state.js "${classroomUrl}"`, { stdio: 'inherit' });

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
    execSync(`node scripts/download_all.js "${classroomUrl}"`, { stdio: 'inherit' });
    process.exit(0);
  }

  console.log(`\nFound ${courses.length} courses to download.\n`);

  for (let i = 0; i < courses.length; i++) {
    const c = courses[i];
    console.log(`\n==================================================`);
    console.log(`[${i + 1}/${courses.length}] Processing Course: ${c.title}`);
    console.log(`URL: ${c.url}`);
    console.log(`==================================================\n`);

    try {
      execSync(`node scripts/download_all.js "${c.url}"`, { stdio: 'inherit' });
    } catch (err) {
      console.error(`[ERROR] Failed to download course ${c.title}:`, err.message);
    }
  }

  console.log(`\n==================================================`);
  console.log(`[SUCCESS] All courses in the classroom have been processed!`);
  console.log(`==================================================\n`);
} catch (err) {
  console.error(`\n[ERROR] An error occurred during download:everything:`, err.message);
  process.exit(1);
}
