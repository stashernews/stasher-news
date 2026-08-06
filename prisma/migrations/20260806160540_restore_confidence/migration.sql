-- Restore confidence() deleted by 20260727054513_stealth_baseline (the fork's
-- baseline dropped the upstream migrations that created it and never recreated
-- them). Backs worker/trust.js:212 (trust job, daily 02:00) — Wilson score
-- lower bound, verbatim from upstream migration 20220630170204_upvote_trust.
-- Signature verified against the live call site: PG 16 implicitly casts the
-- numeric Z_CONFIDENCE literal to FLOAT, so (FLOAT, FLOAT, FLOAT) matches
-- confidence(before - disagree, b_total - after, ${Z_CONFIDENCE}).
CREATE OR REPLACE FUNCTION confidence(successes FLOAT, trials FLOAT, z FLOAT)
RETURNS FLOAT
LANGUAGE plpgsql
AS $$
DECLARE
    p FLOAT;
    lhand FLOAT;
    rhand FLOAT;
    under FLOAT;
BEGIN
    IF trials = 0 THEN
        RETURN 0;
    END IF;

    p := successes / trials;
    lhand := p + 1 / (2 * trials) * z * z;
    rhand := z * sqrt(p * (1 - p) / trials + z * z / (4 * trials * trials));
    under := 1 + 1 / trials * z * z;

    RETURN (lhand - rhand) / under;
END;
$$;
