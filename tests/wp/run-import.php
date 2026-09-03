<?php
/**
 * E2E helper (wp eval-file): run every import step in order — exactly what the
 * admin screen's AJAX loop does, one step at a time.
 */

$job = get_option( 'sri_job' );
if ( ! is_array( $job ) || empty( $job['package'] ) ) {
	echo "NO JOB\n";
	exit( 1 );
}

$steps = sri_build_steps( $job['package'] );
$total = count( $steps );

foreach ( $steps as $i => $step ) {
	$log = SRI_Importer::run_step( $job, $step );
	echo sprintf( "[%d/%d] %s — %s\n", $i + 1, $total, $step['label'], $log );
}

foreach ( ( $job['results'] ?? array() ) as $r ) {
	echo 'RESULT: ' . json_encode( $r ) . "\n";
}

echo "IMPORT LOOP DONE\n";
