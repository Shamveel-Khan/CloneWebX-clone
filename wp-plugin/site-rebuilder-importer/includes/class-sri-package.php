<?php
/**
 * Package handling: unzip the uploaded export and create the import job.
 *
 * @package SiteRebuilder
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class SRI_Package {

	/**
	 * Move the uploaded ZIP, extract it and store the import job in options.
	 *
	 * @param array $file Entry from $_FILES.
	 * @return true|WP_Error
	 */
	public static function create_job_from_upload( $file ) {
		require_once ABSPATH . 'wp-admin/includes/file.php';

		$moved = wp_handle_upload(
			$file,
			array(
				'test_form' => false,
				'test_type' => false,
				'mimes'     => array( 'zip' => 'application/zip' ),
			)
		);
		if ( ! is_array( $moved ) || empty( $moved['file'] ) ) {
			$msg = is_array( $moved ) && isset( $moved['error'] ) ? $moved['error'] : 'Could not store the uploaded file.';
			return new WP_Error( 'sri_upload', $msg );
		}

		$upload_dir = wp_upload_dir();
		$dest       = trailingslashit( $upload_dir['basedir'] ) . 'sri-import-' . get_current_user_id() . '-' . time();

		$unzipped = self::extract_zip( $moved['file'], $dest );
		wp_delete_file( $moved['file'] );
		if ( is_wp_error( $unzipped ) ) {
			self::rrmdir( $dest );
			return new WP_Error(
				'sri_unzip',
				'Could not extract the ZIP: ' . $unzipped->get_error_message()
			);
		}

		$pkg_path = $dest . '/package.json';
		if ( ! file_exists( $pkg_path ) ) {
			self::rrmdir( $dest );
			return new WP_Error( 'sri_package', 'package.json not found — is this a Site Rebuilder export?' );
		}
		$package = json_decode( (string) file_get_contents( $pkg_path ), true ); // phpcs:ignore WordPress.WP.AlternativeFunctions
		if ( ! is_array( $package ) || empty( $package['pages'] ) || ! is_array( $package['pages'] ) ) {
			self::rrmdir( $dest );
			return new WP_Error( 'sri_package', 'package.json is invalid or contains no pages.' );
		}

		$job = array(
			'dir'      => $dest,
			'package'  => $package,
			'map'      => array(),   // package asset path → media library URL.
			'templates' => array(),  // which → template post ID.
			'results'  => array(),
			'created'  => time(),
		);
		update_option( SRI_OPTION_JOB, $job, false );

		return true;
	}

	/**
	 * Extract the export ZIP with direct PHP instead of unzip_file().
	 *
	 * unzip_file() requires the WP Filesystem API, whose method negotiation
	 * can select an FTP method (and fail without credentials) on hosts where
	 * the WordPress files are not owned by the PHP process — even when direct
	 * writes to uploads work fine, which wp_handle_upload() has already proven
	 * by the time this runs. Packages only ever extract into uploads, so use
	 * ZipArchive directly, with the core-bundled PclZip as a fallback.
	 *
	 * @param string $zip_path Absolute path to the uploaded ZIP.
	 * @param string $dest     Absolute extraction directory.
	 * @return true|WP_Error
	 */
	public static function extract_zip( $zip_path, $dest ) {
		if ( ! wp_mkdir_p( $dest ) && ! is_dir( $dest ) ) {
			return new WP_Error( 'sri_unzip_dir', 'could not create the extraction directory' );
		}

		if ( class_exists( 'ZipArchive' ) ) {
			$zip    = new ZipArchive();
			$opened = $zip->open( $zip_path );
			if ( true !== $opened ) {
				return new WP_Error( 'sri_unzip_open', 'ZipArchive could not open the package (code ' . (int) $opened . ')' );
			}
			for ( $i = 0; $i < $zip->numFiles; $i++ ) {
				$entry = $zip->getNameIndex( $i );
				if ( ! is_string( $entry ) || '' === $entry ) {
					continue;
				}
				// Path-traversal guard: never extract entries escaping $dest.
				$clean = ltrim( $entry, '/' );
				if ( false !== strpos( $clean, '..' ) || ':' === substr( $clean, 1, 1 ) ) {
					continue;
				}
				if ( ! $zip->extractTo( $dest, $entry ) ) {
					$zip->close();
					return new WP_Error( 'sri_unzip_entry', 'could not extract "' . $entry . '"' );
				}
			}
			$zip->close();
			return true;
		}

		// ZipArchive unavailable → PclZip ships with WordPress core.
		if ( ! defined( 'PCLZIP_TEMPORARY_DIR' ) && function_exists( 'get_temp_dir' ) ) {
			define( 'PCLZIP_TEMPORARY_DIR', trailingslashit( get_temp_dir() ) );
		}
		require_once ABSPATH . 'wp-admin/includes/class-pclzip.php';
		$archive   = new PclZip( $zip_path );
		$extracted = $archive->extract( PCLZIP_OPT_PATH, $dest );
		if ( ! is_array( $extracted ) || 0 === count( $extracted ) ) {
			$msg = property_exists( $archive, 'error_string' ) ? (string) $archive->error_string : 'unknown error';
			return new WP_Error( 'sri_unzip_pcl', 'PclZip failed: ' . $msg );
		}
		return true;
	}

	/**
	 * Recursively delete a directory (used for extracted packages).
	 *
	 * @param string $dir Absolute path.
	 */
	public static function rrmdir( $dir ) {
		if ( ! is_string( $dir ) || '' === $dir || ! is_dir( $dir ) ) {
			return;
		}
		// Defensive: only ever delete inside wp-uploads with our prefix.
		$upload_dir = wp_upload_dir();
		if ( 0 !== strpos( trailingslashit( $dir ), trailingslashit( $upload_dir['basedir'] ) ) ) {
			return;
		}
		if ( 0 !== strpos( basename( $dir ), 'sri-import-' ) ) {
			return;
		}
		$items = @scandir( $dir );
		if ( ! is_array( $items ) ) {
			return;
		}
		foreach ( array_diff( $items, array( '.', '..' ) ) as $item ) {
			$path = $dir . '/' . $item;
			if ( is_dir( $path ) ) {
				self::rrmdir( $path );
			} else {
				wp_delete_file( $path );
			}
		}
		@rmdir( $dir ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
	}
}
