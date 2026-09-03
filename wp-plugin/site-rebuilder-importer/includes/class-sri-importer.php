<?php
/**
 * Import runner: executes one step per AJAX request so imports survive
 * shared-hosting execution limits (InfinityFree etc.).
 *
 * @package SiteRebuilder
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class SRI_Importer {

	/**
	 * Execute a single import step, mutating the job.
	 *
	 * @param array $job  Import job (by reference).
	 * @param array $step Step definition.
	 * @return string Human-readable log line.
	 */
	public static function run_step( &$job, $step ) {
		switch ( $step['type'] ) {
			case 'template_header':
				return self::import_template( $job, 'header' );
			case 'template_footer':
				return self::import_template( $job, 'footer' );
			case 'page':
				$index = isset( $step['index'] ) ? (int) $step['index'] : -1;
				$page  = $job['package']['pages'][ $index ] ?? null;
				if ( ! is_array( $page ) ) {
					return 'Page step had no data — skipped.';
				}
				return self::import_page( $job, $page );
			case 'styles':
				return self::apply_styles( $job );
			case 'menu':
				return self::create_menu( $job );
			case 'finish':
				return self::finish( $job );
		}
		return 'Unknown step — skipped.';
	}

	/* ------------------------------------------------------------------ page */

	protected static function import_page( &$job, $page ) {
		$elements = self::map_assets( $job, $page['elements'] ?? array() );

		$title   = sanitize_text_field( $page['title'] ?? '' );
		$slug    = sanitize_title( $page['slug'] ?? '' );
		$page_id = wp_insert_post(
			array(
				'post_title'     => $title ? $title : __( 'Imported page', 'site-rebuilder' ),
				'post_name'      => $slug,
				'post_status'    => 'publish',
				'post_type'      => 'page',
				'comment_status' => 'closed',
				'ping_status'    => 'closed',
			),
			true
		);

		if ( is_wp_error( $page_id ) ) {
			$job['results'][] = array( 'type' => 'notice', 'label' => 'Failed to create page "' . $title . '": ' . $page_id->get_error_message() );
			return 'Page "' . $title . '" failed.';
		}

		self::write_elementor_meta( $page_id, $elements, 'wp-page' );
		// Blank-ish template so our containers span the full width and the
		// injected header/footer hooks fire cleanly.
		update_post_meta( $page_id, '_wp_page_template', 'elementor_header_footer' );

		$edit_url = admin_url( 'post.php?post=' . $page_id . '&action=elementor' );
		$view_url = get_permalink( $page_id );

		$job['results'][] = array(
			'type'      => 'page',
			'label'     => $title ? $title : 'Page ' . $page_id,
			'pageId'    => (int) $page_id,
			'sourceUrl' => $page['sourceUrl'] ?? '',
			'editUrl'   => $edit_url,
			'viewUrl'   => $view_url,
		);

		return 'Imported page "' . $title . '" (ID ' . $page_id . ').';
	}

	/* -------------------------------------------------------------- templates */

	protected static function import_template( &$job, $which ) {
		if ( ! post_type_exists( 'elementor_library' ) ) {
			$job['results'][] = array(
				'type'  => 'notice',
				'label' => ucfirst( $which ) . ' template skipped — Elementor is not active. Pages still import.',
			);
			return ucfirst( $which ) . ' skipped (Elementor inactive).';
		}

		$elements = self::map_assets( $job, $job['package'][ $which ] ?? array() );
		if ( empty( $elements ) ) {
			return 'No ' . $which . ' content in package.';
		}

		$template_id = wp_insert_post(
			array(
				'post_title'  => 'header' === $which ? 'Imported Header' : 'Imported Footer',
				'post_name'   => 'sr-imported-' . $which,
				'post_status' => 'publish',
				'post_type'   => 'elementor_library',
			),
			true
		);
		if ( is_wp_error( $template_id ) ) {
			return ucfirst( $which ) . ' template failed: ' . $template_id->get_error_message();
		}

		self::write_elementor_meta( $template_id, $elements, $which );
		update_post_meta( $template_id, '_wp_page_template', 'elementor_canvas' );
		// Elementor Pro theme-builder conditions (harmless without Pro).
		update_post_meta( $template_id, '_elementor_conditions', array( 'include/' . $which ) );

		$job['templates'][ $which ] = (int) $template_id;
		update_option( SRI_OPTION_TEMPLATES, $job['templates'], false );

		$job['results'][] = array(
			'type'    => 'template',
			'label'   => ucfirst( $which ) . ' template (editable in Templates → Saved Templates)',
			'editUrl' => admin_url( 'post.php?post=' . $template_id . '&action=elementor' ),
			'viewUrl' => '',
		);

		return 'Imported ' . $which . ' template (ID ' . $template_id . ').';
	}

	/* ------------------------------------------------------------------ meta */

	protected static function write_elementor_meta( $post_id, $elements, $template_type ) {
		update_post_meta( $post_id, '_elementor_data', wp_slash( wp_json_encode( array_values( $elements ) ) ) );
		update_post_meta( $post_id, '_elementor_edit_mode', 'builder' );
		update_post_meta( $post_id, '_elementor_template_type', $template_type );
		update_post_meta( $post_id, '_elementor_version', defined( 'ELEMENTOR_VERSION' ) ? ELEMENTOR_VERSION : SRI_VERSION );
	}

	/* ---------------------------------------------------------------- assets */

	/**
	 * Walk the element tree and swap package asset paths for Media Library
	 * URLs. `array_walk_recursive` visits leaf values, which is where every
	 * Elementor URL lives (settings.image.url, host_link.url, …).
	 *
	 * @param array $job Import job.
	 * @param mixed $elements Element tree.
	 * @return mixed
	 */
	protected static function map_assets( $job, $elements ) {
		if ( ! is_array( $elements ) ) {
			return $elements;
		}
		array_walk_recursive(
			$elements,
			function ( &$value ) use ( &$job ) {
				if ( is_string( $value ) && 0 === strpos( $value, 'assets/' ) ) {
					$url = SRI_Media::resolve( $job, $value );
					if ( $url ) {
						$value = $url;
					}
				}
			}
		);
		return $elements;
	}

	/* ----------------------------------------------------------------- styles */

	protected static function apply_styles( &$job ) {
		$styles = $job['package']['siteStyles'] ?? array();
		if ( ! is_array( $styles ) || ( empty( $styles ) ) ) {
			return 'No global styles in package (colors and typography are baked into each element).';
		}

		$kit_id = get_option( 'elementor_active_kit' );
		if ( ! $kit_id || get_post_type( $kit_id ) !== 'elementor_kit' ) {
			return 'Active Elementor kit not found — skipping global styles (styles are already baked into each element).';
		}

		$kit = json_decode( (string) get_post_meta( $kit_id, '_elementor_data', true ), true );
		if ( ! is_array( $kit ) ) {
			$kit = array();
		}

		if ( ! empty( $styles['bodyBackground'] ) ) {
			$kit['body_background_background'] = 'classic';
			$kit['body_background_color']      = sanitize_text_field( $styles['bodyBackground'] );
		}
		$has_typo = false;
		if ( ! empty( $styles['bodyFontFamily'] ) ) {
			$kit['body_typography_font_family'] = sanitize_text_field( $styles['bodyFontFamily'] );
			$has_typo                           = true;
		}
		if ( ! empty( $styles['bodyFontSize'] ) ) {
			$kit['body_typography_font_size'] = array(
				'unit'  => 'px',
				'size'  => (int) $styles['bodyFontSize'],
				'sizes' => array(),
			);
			$has_typo                         = true;
		}
		if ( ! empty( $styles['bodyColor'] ) ) {
			$kit['body_typography_color'] = sanitize_text_field( $styles['bodyColor'] );
			$has_typo                     = true;
		}
		if ( $has_typo ) {
			$kit['body_typography_typography'] = 'custom';
		}

		update_post_meta( $kit_id, '_elementor_data', wp_slash( wp_json_encode( $kit ) ) );
		return 'Applied body typography and background to the active Elementor kit.';
	}

	/* ------------------------------------------------------------------- menu */

	protected static function create_menu( &$job ) {
		$items = $job['package']['navigation'] ?? array();
		if ( ! is_array( $items ) || ! $items ) {
			return 'No navigation links found in package.';
		}

		// Map source page URLs → imported page IDs for real menu links.
		$by_source = array();
		foreach ( ( $job['results'] ?? array() ) as $result ) {
			if ( ! empty( $result['pageId'] ) && ! empty( $result['sourceUrl'] ) ) {
				$by_source[ $result['sourceUrl'] ] = (int) $result['pageId'];
			}
		}

		$menu_name = 'Site Rebuilder Nav';
		$menu_id   = 0;
		foreach ( wp_get_nav_menus() as $menu ) {
			if ( $menu->name === $menu_name ) {
				$menu_id = (int) $menu->term_id;
				break;
			}
		}
		if ( ! $menu_id ) {
			$menu_id = wp_create_nav_menu( $menu_name );
			if ( is_wp_error( $menu_id ) ) {
				return 'Could not create navigation menu: ' . $menu_id->get_error_message();
			}
		}

		$created = 0;
		foreach ( $items as $item ) {
			$href = $item['href'] ?? '';
			$text = sanitize_text_field( $item['text'] ?? '' );
			if ( ! $text ) {
				continue;
			}
			$args = array(
				'menu-item-title'  => $text,
				'menu-item-status' => 'publish',
			);
			if ( isset( $by_source[ $href ] ) ) {
				$args['menu-item-object']    = 'page';
				$args['menu-item-object-id'] = $by_source[ $href ];
				$args['menu-item-type']      = 'post_type';
			} else {
				$args['menu-item-url']  = esc_url_raw( $href );
				$args['menu-item-type'] = 'custom';
			}
			if ( wp_update_nav_menu_item( $menu_id, 0, $args ) ) {
				$created++;
			}
		}

		// Assign to the primary location if it is free.
		$locations = get_theme_mod( 'nav_menu_locations', array() );
		if ( array_key_exists( 'primary', $locations ) && empty( $locations['primary'] ) ) {
			$locations['primary'] = $menu_id;
			set_theme_mod( 'nav_menu_locations', $locations );
		}

		return sprintf( 'Created navigation menu with %d item(s).', $created );
	}

	/* ----------------------------------------------------------------- finish */

	protected static function finish( &$job ) {
		if ( ! empty( $job['dir'] ) ) {
			SRI_Package::rrmdir( $job['dir'] );
		}
		delete_option( SRI_OPTION_JOB );
		return 'Import complete — package cleaned up.';
	}
}
