<?php
/**
 * Media import: package assets → WordPress Media Library.
 *
 * @package SiteRebuilder
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class SRI_Media {

	/**
	 * Resolve a package-relative asset path ("assets/abc.png") to a Media
	 * Library URL, importing it on first use. Falls back to the original
	 * remote URL when the file or the import fails.
	 *
	 * @param array  $job     Import job (by reference; keeps the map).
	 * @param string $relPath Path inside the package.
	 * @return string URL or '' when nothing usable was found.
	 */
	public static function resolve( &$job, $relPath ) {
		if ( ! is_string( $relPath ) || '' === $relPath ) {
			return '';
		}
		if ( isset( $job['map'][ $relPath ] ) ) {
			return $job['map'][ $relPath ];
		}

		$abs = $job['dir'] . '/' . ltrim( $relPath, '/' );

		// Defensive path check.
		if ( false !== strpos( $relPath, '..' ) || ! file_exists( $abs ) ) {
			return self::fallback_url( $job, $relPath );
		}

		$data = file_get_contents( $abs ); // phpcs:ignore WordPress.WP.AlternativeFunctions
		if ( false === $data || '' === $data ) {
			return self::fallback_url( $job, $relPath );
		}

		$filename = sanitize_file_name( basename( $relPath ) );
		$upload   = wp_upload_bits( $filename, null, $data );
		if ( ! empty( $upload['error'] ) ) {
			return self::fallback_url( $job, $relPath );
		}

		$filetype = wp_check_filetype( $upload['file'] );
		$attach_id = wp_insert_attachment(
			array(
				'post_mime_type' => $filetype['type'] ?? 'application/octet-stream',
				'post_title'     => pathinfo( $filename, PATHINFO_FILENAME ),
				'post_status'    => 'inherit',
			),
			$upload['file']
		);
		if ( is_wp_error( $attach_id ) || ! $attach_id ) {
			return self::fallback_url( $job, $relPath );
		}

		require_once ABSPATH . 'wp-admin/includes/image.php';
		wp_update_attachment_metadata( $attach_id, wp_generate_attachment_metadata( $attach_id, $upload['file'] ) );

		$url = wp_get_attachment_url( $attach_id );
		if ( ! $url ) {
			return self::fallback_url( $job, $relPath );
		}

		$job['map'][ $relPath ] = $url;
		return $url;
	}

	/**
	 * When local import fails, use the original remote URL recorded in the
	 * package (assets map), so images still render from the source site.
	 *
	 * @param array  $job     Import job.
	 * @param string $relPath Package path.
	 * @return string
	 */
	protected static function fallback_url( $job, $relPath ) {
		$assets = $job['package']['assets'] ?? array();
		if ( isset( $assets[ $relPath ]['url'] ) && is_string( $assets[ $relPath ]['url'] ) ) {
			return esc_url_raw( $assets[ $relPath ]['url'] );
		}
		return '';
	}
}
