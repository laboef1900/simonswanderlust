"""Focused disclosure-boundary tests; run separately from the native qualification."""
import json
import unittest

from build_diagnostics import (
    MAX_EXCERPT_CHARS, MAX_LINES, MAX_SCAN_CHARS, build_failure, excerpt,
)

FIXTURE_PASSWORD = 'fixture-' + 'f' * 64


class BuildDiagnosticTests(unittest.TestCase):
    def test_keeps_actionable_build_errors_not_progress(self):
        lines = [
            '#8 [native-build 5/8] RUN ["node", "container-toolchain.mjs"]',
            '#8 0.23 E: Release file for https://snapshot.debian.org/archive/debian/20261029T000000Z/dists/trixie/InRelease is not valid yet (invalid for another 2h).',
            '#9 0.42 owned-flock.c:17:3: error: missing declaration',
            '#10 0.50 npm error code EINTEGRITY',
            '#8 0.10 Reading package lists...',
            '#8 0.20 Get:1 package download',
        ]
        result = excerpt('\n'.join(lines), FIXTURE_PASSWORD)
        self.assertEqual(result['lines'][0], lines[0])
        self.assertIn('Release file for https://snapshot.debian.', result['lines'][1])
        self.assertIn('is not valid yet (invalid for another 2h)', result['lines'][1])
        self.assertEqual(result['lines'][2:], lines[2:4])
        self.assertEqual(result['withheldLines'], 0)

    def test_keeps_apt_exact_version_conflicts_and_solver_decisions(self):
        lines = [
            '#13 2.423  cpp-14 : Depends: gcc-14-base (= 14.2.0-19) but 14.2.0-19+dhi5 is to be installed',
            '#13 2.423  libc6-dev : Depends: libc6 (= 2.41-12+deb13u4) but 2.41-12+deb13u4+dhi1 is to be installed',
            '             Depends: libcrypt-dev but it is not going to be installed',
            '   1. libc6:arm64=2.41-12+deb13u4 is not selected for install',
            '   2. libc6:amd64=2.41-12+deb13u4 is selected as a downgrade because:',
            '      2. libc6-dev:arm64 Depends libc6 (= 2.41-12+deb13u4)',
            '      2. gcc-14-base:arm64=14.2.0-19 conflicts with other versions of itself',
        ]
        result = excerpt('\n'.join(lines + [
            'Unrelated neighbouring output',
            '  gcc libc6-dev binutils',
            '  1. Download completed',
        ]), FIXTURE_PASSWORD)
        self.assertEqual(result['lines'], lines)
        self.assertEqual(result['withheldLines'], 0)

    def test_new_apt_selection_preserves_disclosure_checks(self):
        unsafe = [
            ' libc6-dev : Depends: password short-value',
            ' Depends: ' + FIXTURE_PASSWORD,
            '#13 2.423 1. libc6:arm64 is selected https://unknown.example/a',
            ' Depends: https://owner:short-value@snapshot.debian.org/a',
            ' Depends: https://snapshot.debian.org/a?access=short-value',
            ' Depends: \x1b[31mhidden-control',
            ' Depends: non-ASCII \u202ehidden',
        ]
        result = excerpt('\n'.join(unsafe), FIXTURE_PASSWORD)
        self.assertEqual(result['lines'], [])
        self.assertEqual(result['withheldLines'], len(unsafe))
        opaque = 'aB01' * 16
        self.assertEqual(excerpt(' Depends: ' + opaque, FIXTURE_PASSWORD)['lines'],
                         [' Depends: [opaque-value-withheld]'])

    def test_withholds_sensitive_lines_before_export(self):
        lines = [
            'ERROR password: short-value',
            'ERROR Authorization: Bearer short-value',
            'ERROR token short-value',
            'ERROR postgresql://owner:short-value@localhost/db',
            'ERROR ' + FIXTURE_PASSWORD,
            'ERROR https://owner:short-value@snapshot.debian.org/archive/',
            'ERROR https://registry.npmjs.org/a?access=short-value',
            'ERROR https://unknown.example/a',
            'ERROR http://snapshot.debian.org/a',
            'ERROR https://snapshot.debian.org:bad/a',
            'ERROR github_pat_short-value',
            'ERROR eyJhbGci.example.value',
            'ERROR \x1b[31mhidden-control',
            'ERROR non-ASCII \u202ehidden',
        ]
        result = excerpt('\n'.join(lines), FIXTURE_PASSWORD)
        self.assertEqual(result['lines'], [])
        self.assertEqual(result['withheldLines'], len(lines))

    def test_removes_unlabelled_opaque_values(self):
        opaque = 'aB01' * 16
        result = excerpt('ERROR failed for ' + opaque, FIXTURE_PASSWORD)
        self.assertEqual(result['lines'], ['ERROR failed for [opaque-value-withheld]'])
        self.assertNotIn(opaque, json.dumps(result))

    def test_bounds_lines_and_characters_and_keeps_latest_errors(self):
        result = excerpt('\n'.join('ERROR ' + str(i) + ' ' + 'x ' * 400 for i in range(200)), FIXTURE_PASSWORD)
        self.assertLessEqual(len(result['lines']), MAX_LINES)
        self.assertLessEqual(sum(len(line) + 1 for line in result['lines']), MAX_EXCERPT_CHARS)
        self.assertTrue(result['excerptTruncated'])
        self.assertTrue(result['lines'][-1].startswith('ERROR 199 '))

    def test_withholds_overlong_line_without_cutting_off_its_secret_marker(self):
        result = excerpt('ERROR ' + 'x ' * 1000 + ' password short-value', FIXTURE_PASSWORD)
        self.assertEqual(result['lines'], [])
        self.assertEqual(result['withheldLines'], 1)

    def test_scan_boundary_drops_partial_first_line(self):
        text = 'password ' + 'x' * MAX_SCAN_CHARS + ' ERROR hidden\nERROR final failure'
        result = excerpt(text, FIXTURE_PASSWORD)
        self.assertTrue(result['scanTruncated'])
        self.assertEqual(result['lines'], ['ERROR final failure'])

    def test_both_streams_are_screened_and_no_raw_output_is_returned(self):
        result = build_failure('ERROR password short-value', 'ERROR compiler failed', FIXTURE_PASSWORD)
        self.assertEqual(result['stdout']['lines'], [])
        self.assertEqual(result['stderr']['lines'], ['ERROR compiler failed'])
        self.assertNotIn('short-value', json.dumps(result))
        self.assertEqual(set(result), {'scope', 'stdout', 'stderr'})


if __name__ == '__main__':
    unittest.main()
