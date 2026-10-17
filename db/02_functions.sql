-- apply_payment: the only way money is applied to a loan.
--
-- Allocation: oldest unpaid installment first; within an installment, interest before principal.
-- Partial payments are allowed. It raises an error when the loan is unknown or closed,
-- when the amount is not positive, or when it exceeds the loan's total outstanding.
-- It closes the loan when nothing is left to pay.
--
-- It is NOT idempotent: calling it twice applies the payment twice.
CREATE FUNCTION apply_payment(p_loan_no text, p_amount bigint, p_value_date date)
RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
    v_loan       loans%ROWTYPE;
    v_total      bigint;
    v_left       bigint := p_amount;
    v_payment_id int;
    v_inst       installments%ROWTYPE;
    v_int        bigint;
    v_prin       bigint;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'amount must be a positive whole number of MNT, got %', p_amount;
    END IF;
    IF p_value_date IS NULL THEN
        RAISE EXCEPTION 'value_date is required';
    END IF;

    SELECT * INTO v_loan FROM loans WHERE loan_no = p_loan_no FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'loan % not found', p_loan_no;
    END IF;
    IF v_loan.status = 'closed' THEN
        RAISE EXCEPTION 'loan % is closed', p_loan_no;
    END IF;

    SELECT total_outstanding INTO v_total FROM loan_balances WHERE loan_id = v_loan.id;
    IF p_amount > v_total THEN
        RAISE EXCEPTION 'amount % exceeds total outstanding % on loan %', p_amount, v_total, p_loan_no;
    END IF;

    INSERT INTO payments (loan_id, amount, value_date, source)
    VALUES (v_loan.id, p_amount, p_value_date, 'reconciliation')
    RETURNING id INTO v_payment_id;

    FOR v_inst IN
        SELECT * FROM installments
        WHERE loan_id = v_loan.id
          AND (principal_paid < principal_due OR interest_paid < interest_due)
        ORDER BY seq
        FOR UPDATE
    LOOP
        EXIT WHEN v_left = 0;
        v_int  := LEAST(v_left, v_inst.interest_due - v_inst.interest_paid);
        v_left := v_left - v_int;
        v_prin := LEAST(v_left, v_inst.principal_due - v_inst.principal_paid);
        v_left := v_left - v_prin;

        UPDATE installments
        SET interest_paid  = interest_paid  + v_int,
            principal_paid = principal_paid + v_prin
        WHERE id = v_inst.id;

        INSERT INTO payment_allocations (payment_id, installment_id, interest, principal)
        VALUES (v_payment_id, v_inst.id, v_int, v_prin);
    END LOOP;

    IF (SELECT total_outstanding FROM loan_balances WHERE loan_id = v_loan.id) = 0 THEN
        UPDATE loans SET status = 'closed' WHERE id = v_loan.id;
    END IF;

    RETURN v_payment_id;
END;
$$;

-- Overdue amount: unpaid parts of installments due before p_as_of.
CREATE FUNCTION loan_overdue(p_loan_no text, p_as_of date)
RETURNS bigint
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(SUM(i.principal_due - i.principal_paid + i.interest_due - i.interest_paid), 0)
    FROM installments i
    JOIN loans l ON l.id = i.loan_id
    WHERE l.loan_no = p_loan_no
      AND i.due_date < p_as_of;
$$;

-- The first installment that is not fully paid, and how much of it remains.
CREATE FUNCTION loan_next_installment(p_loan_no text)
RETURNS TABLE (seq int, due_date date, amount_remaining bigint)
LANGUAGE sql STABLE AS $$
    SELECT i.seq, i.due_date,
           i.principal_due - i.principal_paid + i.interest_due - i.interest_paid
    FROM installments i
    JOIN loans l ON l.id = i.loan_id
    WHERE l.loan_no = p_loan_no
      AND (i.principal_paid < i.principal_due OR i.interest_paid < i.interest_due)
    ORDER BY i.seq
    LIMIT 1;
$$;
