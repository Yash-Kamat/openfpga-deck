import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	assetName,
	detectPlatform,
	downloadUrl,
	findAsset,
	isAllowedDownloadUrl,
	isSafeArchiveEntry,
	parseReleaseInfo,
	tagLooksValid,
} from '../../toolchain/releases';

describe('detectPlatform', () => {
	it('maps the supported platform/arch pairs', () => {
		assert.equal(detectPlatform('linux', 'x64'), 'linux-x64');
		assert.equal(detectPlatform('linux', 'arm64'), 'linux-arm64');
		assert.equal(detectPlatform('darwin', 'arm64'), 'darwin-arm64');
		assert.equal(detectPlatform('win32', 'x64'), 'windows-x64');
	});

	it('returns undefined for anything else', () => {
		assert.equal(detectPlatform('linux', 'ia32'), undefined);
		assert.equal(detectPlatform('freebsd', 'x64'), undefined);
	});
});

describe('tagLooksValid', () => {
	it('accepts a date tag and rejects other shapes', () => {
		assert.equal(tagLooksValid('2026-06-29'), true);
		assert.equal(tagLooksValid(' 2026-06-29 '), true);
		assert.equal(tagLooksValid('20260629'), false);
		assert.equal(tagLooksValid('latest'), false);
		assert.equal(tagLooksValid('v2026.06.29'), false);
	});
});

describe('assetName / downloadUrl', () => {
	it('strips the dashes from the date in the filename but not the tag in the URL', () => {
		assert.equal(assetName('2026-06-29', 'linux-x64'), 'oss-cad-suite-linux-x64-20260629.tgz');
		assert.equal(
			downloadUrl('2026-06-29', 'linux-x64'),
			'https://github.com/YosysHQ/oss-cad-suite-build/releases/download/2026-06-29/oss-cad-suite-linux-x64-20260629.tgz',
		);
	});
});

describe('isAllowedDownloadUrl', () => {
	it('accepts only HTTPS github.com release-download URLs', () => {
		assert.equal(isAllowedDownloadUrl(downloadUrl('2026-06-29', 'linux-x64')), true);
	});

	it('rejects other hosts, schemes, and paths', () => {
		assert.equal(isAllowedDownloadUrl('http://github.com/YosysHQ/oss-cad-suite-build/releases/download/x/y.tgz'), false);
		assert.equal(isAllowedDownloadUrl('https://evil.example/YosysHQ/oss-cad-suite-build/releases/download/x/y.tgz'), false);
		assert.equal(isAllowedDownloadUrl('https://github.com/YosysHQ/other-repo/releases/download/x/y.tgz'), false);
		assert.equal(isAllowedDownloadUrl('https://github.com.evil.example/YosysHQ/oss-cad-suite-build/releases/download/x/y.tgz'), false);
		assert.equal(isAllowedDownloadUrl('not a url'), false);
	});
});

describe('isSafeArchiveEntry', () => {
	it('accepts normal relative paths', () => {
		assert.equal(isSafeArchiveEntry('oss-cad-suite/bin/yosys'), true);
		assert.equal(isSafeArchiveEntry('oss-cad-suite/'), true);
	});

	it('rejects absolute, parent-escaping, and drive paths', () => {
		assert.equal(isSafeArchiveEntry('/etc/passwd'), false);
		assert.equal(isSafeArchiveEntry('../outside'), false);
		assert.equal(isSafeArchiveEntry('oss-cad-suite/../../x'), false);
		assert.equal(isSafeArchiveEntry('C:\\Windows\\system32'), false);
		assert.equal(isSafeArchiveEntry(''), false);
	});
});

describe('parseReleaseInfo', () => {
	it('extracts the tag, asset names, and sha256 digests', () => {
		const info = parseReleaseInfo({
			tag_name: '2026-06-29',
			assets: [
				{ name: 'oss-cad-suite-linux-x64-20260629.tgz', digest: 'sha256:' + 'a'.repeat(64) },
				{ name: 'oss-cad-suite-windows-x64-20260629.tgz' },
				{ nope: true },
			],
		});
		assert.ok(info);
		assert.equal(info.tag, '2026-06-29');
		assert.equal(info.assets.length, 2);
		const linux = findAsset(info, 'oss-cad-suite-linux-x64-20260629.tgz');
		assert.equal(linux?.sha256, 'a'.repeat(64));
		assert.equal(findAsset(info, 'oss-cad-suite-windows-x64-20260629.tgz')?.sha256, undefined);
	});

	it('ignores a malformed digest', () => {
		const info = parseReleaseInfo({
			tag_name: '2026-06-29',
			assets: [{ name: 'x.tgz', digest: 'md5:abc' }],
		});
		assert.equal(info?.assets[0].sha256, undefined);
	});

	it('returns undefined without a tag_name', () => {
		assert.equal(parseReleaseInfo({ assets: [] }), undefined);
		assert.equal(parseReleaseInfo('nope'), undefined);
	});
});
