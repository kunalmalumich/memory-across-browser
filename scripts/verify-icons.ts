#!/usr/bin/env node
/**
 * Icon Verification Script
 * Verifies that all RememberMe icons are properly configured and exist
 */

import * as fs from 'fs';
import * as path from 'path';

const ICONS_DIR = path.join(__dirname, '../icons');
const DIST_ICONS_DIR = path.join(__dirname, '../dist/icons');
const MANIFEST_PATH = path.join(__dirname, '../manifest.json');

interface IconCheck {
  name: string;
  required: boolean;
  sourcePath: string;
  distPath: string;
  exists: boolean;
  distExists: boolean;
}

const REQUIRED_ICONS: IconCheck[] = [
  {
    name: 'Extension Icon 16x16',
    required: true,
    sourcePath: 'icons/rememberme-icon16.png',
    distPath: 'dist/icons/rememberme-icon16.png',
    exists: false,
    distExists: false,
  },
  {
    name: 'Extension Icon 48x48',
    required: true,
    sourcePath: 'icons/rememberme-icon48.png',
    distPath: 'dist/icons/rememberme-icon48.png',
    exists: false,
    distExists: false,
  },
  {
    name: 'Extension Icon 128x128',
    required: true,
    sourcePath: 'icons/rememberme-icon128.png',
    distPath: 'dist/icons/rememberme-icon128.png',
    exists: false,
    distExists: false,
  },
  {
    name: 'In-App Icon',
    required: true,
    sourcePath: 'icons/rememberme-icon.png',
    distPath: 'dist/icons/rememberme-icon.png',
    exists: false,
    distExists: false,
  },
  {
    name: 'Main Logo',
    required: true,
    sourcePath: 'icons/rememberme-logo-main.png',
    distPath: 'dist/icons/rememberme-logo-main.png',
    exists: false,
    distExists: false,
  },
];

function checkIcons(): void {
  console.log('🔍 Verifying RememberMe Icons...\n');

  let allPassed = true;

  // Check source icons
  console.log('📁 Checking source icons:');
  REQUIRED_ICONS.forEach((icon) => {
    const fullPath = path.join(__dirname, '..', icon.sourcePath);
    icon.exists = fs.existsSync(fullPath);
    
    if (icon.exists) {
      console.log(`  ✅ ${icon.name}: ${icon.sourcePath}`);
    } else {
      console.log(`  ❌ ${icon.name}: ${icon.sourcePath} - MISSING`);
      if (icon.required) {
        allPassed = false;
      }
    }
  });

  // Check dist icons
  console.log('\n📦 Checking built icons (dist/):');
  REQUIRED_ICONS.forEach((icon) => {
    const fullPath = path.join(__dirname, '..', icon.distPath);
    icon.distExists = fs.existsSync(fullPath);
    
    if (icon.distExists) {
      console.log(`  ✅ ${icon.name}: ${icon.distPath}`);
    } else {
      console.log(`  ⚠️  ${icon.name}: ${icon.distPath} - Missing (run npm run build)`);
    }
  });

  // Check manifest.json
  console.log('\n📄 Checking manifest.json:');
  try {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    
    // Check icons section
    if (manifest.icons) {
      console.log('  ✅ Icons section exists');
      ['16', '48', '128'].forEach((size) => {
        const iconPath = manifest.icons[size];
        if (iconPath) {
          const fullPath = path.join(__dirname, '..', iconPath);
          if (fs.existsSync(fullPath)) {
            console.log(`  ✅ Icon ${size}x${size}: ${iconPath}`);
          } else {
            console.log(`  ❌ Icon ${size}x${size}: ${iconPath} - FILE NOT FOUND`);
            allPassed = false;
          }
        } else {
          console.log(`  ❌ Icon ${size}x${size}: Missing from manifest`);
          allPassed = false;
        }
      });
    } else {
      console.log('  ❌ Icons section missing from manifest');
      allPassed = false;
    }

    // Check action.default_icon
    if (manifest.action?.default_icon) {
      console.log('  ✅ Action default_icon exists');
      ['16', '48', '128'].forEach((size) => {
        const iconPath = manifest.action.default_icon[size];
        if (iconPath) {
          const fullPath = path.join(__dirname, '..', iconPath);
          if (fs.existsSync(fullPath)) {
            console.log(`  ✅ Action icon ${size}x${size}: ${iconPath}`);
          } else {
            console.log(`  ❌ Action icon ${size}x${size}: ${iconPath} - FILE NOT FOUND`);
            allPassed = false;
          }
        } else {
          console.log(`  ❌ Action icon ${size}x${size}: Missing from manifest`);
          allPassed = false;
        }
      });
    } else {
      console.log('  ❌ Action default_icon missing from manifest');
      allPassed = false;
    }

    // Check web_accessible_resources
    if (manifest.web_accessible_resources) {
      const hasIconsWildcard = manifest.web_accessible_resources.some(
        (war: any) => war.resources?.includes('icons/*')
      );
      if (hasIconsWildcard) {
        console.log('  ✅ Icons are web accessible (icons/*)');
      } else {
        console.log('  ⚠️  Icons may not be web accessible - check web_accessible_resources');
      }
    }
  } catch (error) {
    console.log(`  ❌ Error reading manifest.json: ${error}`);
    allPassed = false;
  }

  // Summary
  console.log('\n' + '='.repeat(50));
  if (allPassed) {
    console.log('✅ All icon checks passed!');
    console.log('\n📋 Icon Locations Summary:');
    console.log('  • Browser Extension: icons/rememberme-icon{16,48,128}.png');
    console.log('  • Extension Popup: icons/rememberme-icon.png');
    console.log('  • Sidebar/Modals: icons/rememberme-logo-main.png');
    console.log('  • Notifications: icons/rememberme-icon.png');
    console.log('\n💡 Chrome Web Store: Upload 128x128, 256x256, 512x512 icons via Developer Dashboard');
  } else {
    console.log('❌ Some icon checks failed. Please fix the issues above.');
    process.exit(1);
  }
}

checkIcons();

