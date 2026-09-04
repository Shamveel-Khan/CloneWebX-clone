<?php
/**
 * Plugin Name: Site Rebuilder Importer
 * Description: Imports a Site Rebuilder export package (ZIP) as editable Elementor pages, header/footer templates, media library assets and global styles. Works on standard shared hosting.
 * Version:     0.1.0
 * Requires at least: 5.8
 * Requires PHP: 7.4
 * Author:      Site Rebuilder
 * License:     MIT
 * Text Domain: site-rebuilder
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'SRI_VERSION', '0.1.0' );
define( 'SRI_OPTION_JOB', 'sri_job' );
define( 'SRI_OPTION_TEMPLATES', 'sri_template_ids' );
define( 'SRI_OPTION_INJECT', 'sri_inject_header_footer' );

require_once __DIR__ . '/includes/class-sri-package.php';
require_once __DIR__ . '/includes/class-sri-media.php';
require_once __DIR__ . '/includes/class-sri-importer.php';

/*
 * Rebuilt sites rely on SVG (icons, logos, illustrations) and AVIF imagery,
 * which WordPress does not whitelist for sideloading by default. Widen the
 * mime list while this importer plugin is active (admin-only imports).
 */
add_filter(
	'upload_mimes',
	function ( $mimes ) {
		$mimes['svg']  = 'image/svg+xml';
		$mimes['svgz'] = 'image/svg+xml';
		$mimes['avif'] = 'image/avif';
		$mimes['webp'] = 'image/webp';
		return $mimes;
	}
);

/* -------------------------------------------------------------------------
 * Admin page: Tools → Site Rebuilder
 * ---------------------------------------------------------------------- */

add_action( 'admin_menu', 'sri_admin_menu' );
function sri_admin_menu() {
	add_management_page(
		'Site Rebuilder Importer',
		'Site Rebuilder',
		'manage_options',
		'site-rebuilder',
		'sri_render_admin_page'
	);
}

add_action( 'admin_init', 'sri_handle_upload' );
function sri_handle_upload() {
	if ( empty( $_POST['sri_upload'] ) ) {
		return;
	}
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_die( esc_html__( 'Insufficient permissions.', 'site-rebuilder' ) );
	}
	check_admin_referer( 'sri_upload', 'sri_nonce' );

	update_option( SRI_OPTION_INJECT, empty( $_POST['sri_inject'] ) ? '0' : '1', false );

	if ( empty( $_FILES['sri_package'] ) || UPLOAD_ERR_OK !== (int) $_FILES['sri_package']['error'] ) {
		add_action( 'admin_notices', 'sri_notice_upload_failed' );
		return;
	}
	if ( 'application/zip' !== $_FILES['sri_package']['type'] && ! preg_match( '/\.zip$/i', sanitize_file_name( $_FILES['sri_package']['name'] ) ) ) {
		add_action( 'admin_notices', 'sri_notice_upload_failed' );
		return;
	}

	require_once ABSPATH . 'wp-admin/includes/file.php';
	$result = SRI_Package::create_job_from_upload( $_FILES['sri_package'] );
	if ( is_wp_error( $result ) ) {
		add_action(
			'admin_notices',
			function () use ( $result ) {
				printf(
					'<div class="notice notice-error"><p>%s</p></div>',
					esc_html( $result->get_error_message() )
				);
			}
		);
		return;
	}
	wp_safe_redirect( admin_url( 'tools.php?page=site-rebuilder' ) );
	exit;
}

function sri_notice_upload_failed() {
	printf(
		'<div class="notice notice-error"><p>%s</p></div>',
		esc_html__( 'Upload failed — please choose a valid ZIP package.', 'site-rebuilder' )
	);
}

/**
 * Build the ordered list of import steps for the batch runner.
 *
 * @param array $package Decoded package.json.
 * @return array[] Each step: [ 'type' => ..., 'label' => ... ].
 */
function sri_build_steps( $package ) {
	$steps = array();
	if ( ! empty( $package['header'] ) ) {
		$steps[] = array( 'type' => 'template_header', 'label' => 'Import header template' );
	}
	if ( ! empty( $package['footer'] ) ) {
		$steps[] = array( 'type' => 'template_footer', 'label' => 'Import footer template' );
	}
	foreach ( (array) ( $package['pages'] ?? array() ) as $i => $page ) {
		$steps[] = array(
			'type'  => 'page',
			'index' => (int) $i,
			'label' => sprintf( 'Import page: %s', $page['title'] ?? ( 'Page ' . ( $i + 1 ) ) ),
		);
	}
	$steps[] = array( 'type' => 'styles', 'label' => 'Apply global styles' );
	$steps[] = array( 'type' => 'menu', 'label' => 'Create navigation menu' );
	$steps[] = array( 'type' => 'finish', 'label' => 'Clean up' );
	return $steps;
}

add_action( 'wp_ajax_sri_step', 'sri_ajax_step' );
function sri_ajax_step() {
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_send_json_error( 'Insufficient permissions.' );
	}
	check_ajax_referer( 'sri_step', 'nonce' );

	$index = isset( $_POST['step'] ) ? absint( wp_unslash( $_POST['step'] ) ) : 0;
	$job   = get_option( SRI_OPTION_JOB );
	if ( ! is_array( $job ) || empty( $job['package'] ) ) {
		wp_send_json_error( 'No import job found — upload the package again.' );
	}
	$steps = sri_build_steps( $job['package'] );
	if ( ! isset( $steps[ $index ] ) ) {
		wp_send_json_error( 'Unknown import step.' );
	}

	if ( function_exists( 'wp_raise_memory_limit' ) ) {
		wp_raise_memory_limit( 'image' );
	}

	$step = $steps[ $index ];
	$log  = SRI_Importer::run_step( $job, $step );

	update_option( SRI_OPTION_JOB, $job, false );

	wp_send_json_success(
		array(
			'progress' => (int) round( ( ( $index + 1 ) / max( count( $steps ), 1 ) ) * 100 ),
			'log'      => $log,
			'results'  => $job['results'] ?? array(),
		)
	);
}

/* -------------------------------------------------------------------------
 * Admin page markup + batch runner
 * ---------------------------------------------------------------------- */

function sri_render_admin_page() {
	$job = get_option( SRI_OPTION_JOB );
	?>
	<div class="wrap">
		<h1>Site Rebuilder Importer</h1>

		<?php if ( is_array( $job ) && ! empty( $job['package'] ) ) : ?>
			<?php
			$package = $job['package'];
			$source  = $package['source']['url'] ?? '';
			$pages   = is_array( $package['pages'] ?? null ) ? count( $package['pages'] ) : 0;
			?>
			<p>
				Package found: <strong><?php echo esc_html( $source ); ?></strong>
				(<code><?php echo esc_html( $package['source']['platform'] ?? 'generic' ); ?></code>),
				<?php echo (int) $pages; ?> page<?php echo 1 === $pages ? '' : 's'; ?>.
				<?php if ( ! did_action( 'elementor/loaded' ) ) : ?>
					<strong style="color:#b32d2e;"><?php esc_html_e( 'Elementor is not active — install and activate it so pages open in the editor.', 'site-rebuilder' ); ?></strong>
				<?php endif; ?>
			</p>

			<div style="max-width:640px;">
				<div style="height:22px;border:1px solid #c3c4c7;border-radius:4px;overflow:hidden;background:#fff;">
					<div id="sri-bar" style="height:100%;width:0;background:#2271b1;transition:width .3s;"></div>
				</div>
				<p><strong id="sri-pct">0%</strong> — <span id="sri-status">Waiting…</span></p>
				<ul id="sri-results" style="margin-top:12px;"></ul>
				<p id="sri-donebox" style="display:none;background:#edfaef;border-left:4px solid #00a32a;padding:10px 14px;">
					✅ <?php esc_html_e( 'Import finished. Open', 'site-rebuilder' ); ?>
					<a href="<?php echo esc_url( admin_url( 'edit.php?post_type=page' ) ); ?>"><?php esc_html_e( 'Pages', 'site-rebuilder' ); ?></a>
					<?php esc_html_e( 'and click any page → “Edit with Elementor”.', 'site-rebuilder' ); ?>
				</p>
				<p id="sri-failbox" style="display:none;background:#fcf0f1;border-left:4px solid #b32d2e;padding:10px 14px;"></p>
			</div>

			<script>
				window.SRI_JOB = <?php
				echo wp_json_encode(
					array(
						'steps' => sri_build_steps( $package ),
						'nonce' => wp_create_nonce( 'sri_step' ),
					)
				);
				?>;
			</script>
			<script>
				(function ($) {
					var steps = window.SRI_JOB.steps, i = 0, resultsShown = {};

					function renderResults(list) {
						(list || []).forEach(function (r) {
							if (resultsShown[r.label]) return;
							resultsShown[r.label] = true;
							var li = $('<li>').html(
								(r.type === 'page' ? '📄 ' : r.type === 'notice' ? '⚠️ ' : '🧩 ') +
								$('<span>').text(r.label).html() +
								(r.editUrl ? ' — <a href="' + r.editUrl + '">Edit with Elementor</a>' + (r.viewUrl ? ' · <a href="' + r.viewUrl + '">View</a>' : '') : '')
							);
							$('#sri-results').append(li);
						});
					}

					function next() {
						if (i >= steps.length) {
							$('#sri-status').text('Finished.');
							$('#sri-donebox').show();
							return;
						}
						var step = steps[i];
						$('#sri-status').text(step.label + '…');
						$.post(ajaxurl, { action: 'sri_step', nonce: window.SRI_JOB.nonce, step: i })
							.done(function (res) {
								if (res && res.success) {
									i++;
									$('#sri-bar').css('width', res.data.progress + '%');
									$('#sri-pct').text(res.data.progress + '%');
									$('#sri-status').text(step.label + ' ✓');
									renderResults(res.data.results);
									next();
								} else {
									fail(res && res.data ? res.data : 'Unknown error.');
								}
							})
							.fail(function (xhr) {
								fail('Request failed' + (xhr && xhr.responseText ? ': ' + xhr.responseText.substring(0, 300) : '.') +
									' The page may still import — reload this screen to retry from the same step.');
							});
					}

					function fail(msg) {
						$('#sri-status').text('Error.');
						$('#sri-failbox').text(msg).show();
					}

					next();
				})(jQuery);
			</script>

			<p style="margin-top:24px;">
				<a class="button" href="<?php echo esc_url( admin_url( 'tools.php?page=site-rebuilder&sri_new=1' ) ); ?>"
					onclick="return confirm('Start a new import? The current job is discarded.');">
					Start a new import
				</a>
			</p>

		<?php else : ?>

			<p><?php esc_html_e( 'Upload a .zip exported by the Site Rebuilder Chrome extension. It creates real WordPress pages you can open and edit with Elementor — headings, text, buttons, images and containers are separate editable elements.', 'site-rebuilder' ); ?></p>
			<form method="post" enctype="multipart/form-data" style="max-width:560px;background:#fff;border:1px solid #c3c4c7;padding:16px;border-radius:6px;">
				<?php wp_nonce_field( 'sri_upload', 'sri_nonce' ); ?>
				<p>
					<label for="sri_package"><strong><?php esc_html_e( 'Site Rebuilder package (.zip)', 'site-rebuilder' ); ?></strong></label><br />
					<input type="file" id="sri_package" name="sri_package" accept=".zip,application/zip" required />
				</p>
				<p>
					<label>
						<input type="checkbox" name="sri_inject" value="1" checked />
						<?php esc_html_e( 'Display the imported header & footer on imported pages (recommended)', 'site-rebuilder' ); ?>
					</label>
				</p>
				<p>
					<button type="submit" name="sri_upload" value="1" class="button button-primary button-large">
						<?php esc_html_e( 'Upload &amp; prepare import', 'site-rebuilder' ); ?>
					</button>
				</p>
			</form>
			<p class="description">
				<?php esc_html_e( 'The import runs in small steps (one page per request) so it is safe on shared hosting with short time limits, including InfinityFree.', 'site-rebuilder' ); ?>
			</p>

		<?php endif; ?>
	</div>
	<?php
}

/* -------------------------------------------------------------------------
 * Front end: display imported header/footer on imported pages.
 * Elementor's "Elementor Header Footer" page template renders only the page
 * content, so we print the imported templates ourselves. Two hook families
 * are used, guarded against double printing.
 * ---------------------------------------------------------------------- */

function sri_inject_template( $which ) {
	static $printed = array();
	if ( ! empty( $printed[ $which ] ) ) {
		return;
	}
	if ( '1' !== get_option( SRI_OPTION_INJECT, '1' ) ) {
		return;
	}
	$templates = get_option( SRI_OPTION_TEMPLATES, array() );
	if ( empty( $templates[ $which ] ) || ! get_post( $templates[ $which ] ) ) {
		return;
	}
	$printed[ $which ] = true;

	if ( did_action( 'elementor/loaded' ) && class_exists( '\Elementor\Plugin' ) ) {
		echo \Elementor\Plugin::$instance->frontend->get_builder_content( $templates[ $which ], true ); // phpcs:ignore WordPress.Security.EscapeOutput
	} else {
		$post = get_post( $templates[ $which ] );
		if ( $post ) {
			echo wp_kses_post( apply_filters( 'the_content', $post->post_content ) );
		}
	}
}

function sri_is_imported_page() {
	if ( ! is_singular( array( 'page', 'post' ) ) ) {
		return false;
	}
	return 'elementor_header_footer' === get_page_template_slug( get_queried_object_id() );
}

add_action( 'wp_body_open', 'sri_header_body_open', 2 );
function sri_header_body_open() {
	if ( sri_is_imported_page() ) {
		sri_inject_template( 'header' );
	}
}

add_action( 'elementor/page_templates/header-footer/before_content', 'sri_header_ehf' );
function sri_header_ehf() {
	sri_inject_template( 'header' );
}

add_action( 'wp_footer', 'sri_footer_wp_footer', 1 );
function sri_footer_wp_footer() {
	if ( sri_is_imported_page() ) {
		sri_inject_template( 'footer' );
	}
}

add_action( 'elementor/page_templates/header-footer/after_content', 'sri_footer_ehf' );
function sri_footer_ehf() {
	sri_inject_template( 'footer' );
}
