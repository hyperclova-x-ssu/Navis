-- Up Migration
ALTER TABLE customer.member ADD COLUMN member_code text;

-- This transaction backfills across stores as the table owner. RLS stays enabled
-- for runtime roles and FORCE is restored before the table lock is released.
ALTER TABLE customer.member NO FORCE ROW LEVEL SECURITY;
WITH legacy_codes AS (
    SELECT store_id, member_id, substring(name FROM '손님 (M-[0-9]{4})') AS code,
        row_number() OVER (PARTITION BY store_id, name ORDER BY created_at, member_id) AS occurrence
    FROM customer.member
    WHERE store_id = 'c05409a6-f082-5964-a787-c1ed3184988b'
        AND name ~ '^손님 M-[0-9]{4}$' AND name <> '손님 M-0000'
)
UPDATE customer.member m SET member_code = c.code
FROM legacy_codes c
WHERE (m.store_id, m.member_id) = (c.store_id, c.member_id) AND c.occurrence = 1;

WITH retained AS (
    SELECT store_id, max(substring(member_code FROM 3)::bigint) AS last_number
    FROM customer.member WHERE member_code IS NOT NULL GROUP BY store_id
), numbered AS (
    SELECT m.store_id, m.member_id,
        coalesce(r.last_number, 0) + row_number() OVER (PARTITION BY m.store_id ORDER BY m.created_at, m.member_id) AS number
    FROM customer.member m LEFT JOIN retained r USING (store_id)
    WHERE m.member_code IS NULL
)
UPDATE customer.member m
SET member_code = 'M-' || lpad(n.number::text, greatest(4, length(n.number::text)), '0')
FROM numbered n WHERE (m.store_id, m.member_id) = (n.store_id, n.member_id);

ALTER TABLE customer.member
    ALTER COLUMN member_code SET NOT NULL,
    ADD CONSTRAINT member_code_format CHECK (member_code ~ '^M-([0-9]{4}|[1-9][0-9]{4,18})$' AND member_code <> 'M-0000'),
    ADD CONSTRAINT member_store_code_key UNIQUE (store_id, member_code);

CREATE TABLE customer.member_code_counter (
    store_id uuid PRIMARY KEY,
    last_number bigint NOT NULL CHECK (last_number > 0)
);
INSERT INTO customer.member_code_counter (store_id, last_number)
SELECT store_id, max(substring(member_code FROM 3)::bigint) FROM customer.member GROUP BY store_id;
ALTER TABLE customer.member FORCE ROW LEVEL SECURITY;
ALTER TABLE customer.member_code_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer.member_code_counter FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON customer.member_code_counter TO customer_mig
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));

-- A transactional row lock serializes allocation per store, including direct
-- inserts. The seed may provide a canonical number and advance the same counter.
CREATE FUNCTION customer.assign_member_code() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE next_number bigint;
BEGIN
    IF NEW.member_code IS NULL THEN
        INSERT INTO customer.member_code_counter (store_id, last_number) VALUES (NEW.store_id, 1)
        ON CONFLICT (store_id) DO UPDATE
        SET last_number = customer.member_code_counter.last_number + 1
        RETURNING last_number INTO next_number;
        NEW.member_code := 'M-' || lpad(next_number::text, greatest(4, length(next_number::text)), '0');
    ELSE
        INSERT INTO customer.member_code_counter (store_id, last_number)
        VALUES (NEW.store_id, substring(NEW.member_code FROM 3)::bigint)
        ON CONFLICT (store_id) DO UPDATE SET last_number = EXCLUDED.last_number
        WHERE customer.member_code_counter.last_number < EXCLUDED.last_number;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION customer.assign_member_code() FROM PUBLIC;
CREATE TRIGGER assign_member_code BEFORE INSERT ON customer.member
    FOR EACH ROW EXECUTE FUNCTION customer.assign_member_code();

-- Down Migration
DROP TRIGGER assign_member_code ON customer.member;
DROP FUNCTION customer.assign_member_code();
DROP TABLE customer.member_code_counter;
ALTER TABLE customer.member DROP COLUMN member_code;
