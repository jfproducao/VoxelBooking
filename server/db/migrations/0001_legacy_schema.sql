-- PostgreSQL schema baseline ported from the current MySQL migrations.
-- ULID identifiers remain text-compatible; DATETIME values use timestamp without time zone.

-- PostgreSQL equivalent of MySQL's automatic updated_at behavior.
CREATE OR REPLACE FUNCTION voxelbooking_set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = CURRENT_TIMESTAMP; RETURN NEW; END; $$;

-- Source MySQL migration: 001_create_settings.php
CREATE TABLE IF NOT EXISTS settings (
    key VARCHAR(100) NOT NULL,
    value TEXT NULL,
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (key)
);

-- Source MySQL migration: 002_create_operators.php
CREATE TABLE IF NOT EXISTS operators (
    id CHAR(26) NOT NULL,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
);

CREATE UNIQUE INDEX operators_operators_email_unique ON operators (lower(email));

-- Source MySQL migration: 002_create_operators.php
CREATE TABLE IF NOT EXISTS auth_emails (
    email VARCHAR(255) NOT NULL,
    user_type VARCHAR(15) NOT NULL,
    user_id CHAR(26) NOT NULL,
    PRIMARY KEY (email)
);

CREATE INDEX auth_emails_auth_emails_user ON auth_emails (user_type, user_id);

-- Source MySQL migration: 002_create_operators.php
CREATE TABLE IF NOT EXISTS login_tokens (
    id CHAR(26) NOT NULL,
    email VARCHAR(255) NOT NULL,
    type VARCHAR(20) NOT NULL,
    token_hash VARCHAR(64) NOT NULL,
    remember_me BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    used_at TIMESTAMP WITHOUT TIME ZONE NULL DEFAULT NULL,
    ip_address VARCHAR(45) NULL DEFAULT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
);

CREATE INDEX login_tokens_login_tokens_email_type ON login_tokens (email, type, expires_at);

CREATE INDEX login_tokens_login_tokens_hash ON login_tokens (token_hash);

-- Source MySQL migration: 003_create_tenants.php
CREATE TABLE IF NOT EXISTS tenants (
    id CHAR(26) NOT NULL,
    slug VARCHAR(100) NOT NULL,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NULL DEFAULT NULL,
    timezone VARCHAR(100) NOT NULL DEFAULT 'UTC',
    booking_pattern VARCHAR(20) NOT NULL,
    locale VARCHAR(10) NOT NULL DEFAULT 'en',
    locale_override VARCHAR(10) NULL DEFAULT NULL,
    week_start SMALLINT NOT NULL DEFAULT 1,
    time_format VARCHAR(3) NOT NULL DEFAULT '24h',
    date_format VARCHAR(10) NOT NULL DEFAULT 'Y-m-d',
    number_format VARCHAR(10) NOT NULL DEFAULT 'period',
    currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
    brand_color VARCHAR(7) NOT NULL DEFAULT '#2563EB',
    brand_color_text VARCHAR(7) NOT NULL DEFAULT '#FFFFFF',
    show_powered_by BOOLEAN NOT NULL DEFAULT TRUE,
    logo_path VARCHAR(500) NULL DEFAULT NULL,
    cover_image_path VARCHAR(500) NULL DEFAULT NULL,
    booking_page_heading VARCHAR(255) NULL DEFAULT NULL,
    booking_page_description TEXT NULL DEFAULT NULL,
    confirmation_message TEXT NULL DEFAULT NULL,
    cancellation_policy TEXT NULL DEFAULT NULL,
    allow_cancellation BOOLEAN NOT NULL DEFAULT TRUE,
    cancellation_hours_before INTEGER NOT NULL DEFAULT 24,
    allow_rescheduling BOOLEAN NOT NULL DEFAULT TRUE,
    rescheduling_hours_before INTEGER NOT NULL DEFAULT 24,
    min_advance_hours INTEGER NOT NULL DEFAULT 1,
    max_advance_days INTEGER NOT NULL DEFAULT 90,
    slot_duration_minutes INTEGER NOT NULL DEFAULT 30,
    buffer_minutes INTEGER NOT NULL DEFAULT 0,
    max_bookings_per_customer_per_day INTEGER NOT NULL DEFAULT 3,
    booking_requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
    require_phone BOOLEAN NOT NULL DEFAULT FALSE,
    custom_fields JSONB NULL DEFAULT NULL,
    notification_email VARCHAR(255) NULL DEFAULT NULL,
    notify_on_booking BOOLEAN NOT NULL DEFAULT TRUE,
    notify_on_cancellation BOOLEAN NOT NULL DEFAULT TRUE,
    send_reminders BOOLEAN NOT NULL DEFAULT TRUE,
    reminder_hours_before INTEGER NOT NULL DEFAULT 24,
    requires_consent BOOLEAN NOT NULL DEFAULT TRUE,
    privacy_policy_url VARCHAR(500) NULL DEFAULT NULL,
    consent_text VARCHAR(500) NULL DEFAULT NULL,
    data_retention_months INTEGER NOT NULL DEFAULT 24,
    allowed_embed_domains TEXT NULL DEFAULT NULL,
    embed_button_position VARCHAR(20) NOT NULL DEFAULT 'bottom-right',
    embed_button_label VARCHAR(50) NOT NULL DEFAULT 'Book Now',
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    meta JSONB NULL DEFAULT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
);

CREATE UNIQUE INDEX tenants_tenants_slug_unique ON tenants (lower(slug));

-- Source MySQL migration: 004_create_audit_log.php
CREATE TABLE IF NOT EXISTS audit_log (
    id CHAR(26) NOT NULL,
    tenant_id CHAR(26) NULL DEFAULT NULL,
    actor_type VARCHAR(20) NOT NULL,
    actor_id CHAR(26) NULL DEFAULT NULL,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id CHAR(26) NULL DEFAULT NULL,
    details JSONB NULL DEFAULT NULL,
    ip_address VARCHAR(45) NULL DEFAULT NULL,
    request_id CHAR(36) NOT NULL DEFAULT '',
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
);

CREATE INDEX audit_log_audit_log_tenant_created ON audit_log (tenant_id, created_at);

CREATE INDEX audit_log_audit_log_actor ON audit_log (actor_type, actor_id);

CREATE INDEX audit_log_audit_log_action ON audit_log (action);

CREATE INDEX audit_log_audit_log_entity ON audit_log (entity_type, entity_id);

CREATE INDEX audit_log_audit_log_created ON audit_log (created_at);

-- Source MySQL migration: 005_create_services.php
CREATE TABLE IF NOT EXISTS services (
    id CHAR(26) NOT NULL,
    tenant_id CHAR(26) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT NULL DEFAULT NULL,
    preparation_text TEXT NULL DEFAULT NULL,
    duration_minutes INTEGER NOT NULL DEFAULT 30,
    duration_options JSONB NULL DEFAULT NULL,
    price DECIMAL(10,2) NULL DEFAULT NULL,
    price_label VARCHAR(100) NULL DEFAULT NULL,
    category VARCHAR(100) NULL DEFAULT NULL,
    color VARCHAR(7) NULL DEFAULT NULL,
    cover_image_path VARCHAR(500) NULL DEFAULT NULL,
    max_per_day INTEGER NULL DEFAULT NULL,
    requires_staff BOOLEAN NOT NULL DEFAULT TRUE,
    staff_assignment_strategy VARCHAR(20) NOT NULL DEFAULT 'first_available',
    is_virtual BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    meta JSONB NULL DEFAULT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT services_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE INDEX services_services_tenant_active_idx ON services (tenant_id, is_active, sort_order);

-- Source MySQL migration: 006_create_staff.php
CREATE TABLE IF NOT EXISTS staff (
    id CHAR(26) NOT NULL,
    tenant_id CHAR(26) NOT NULL,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NULL DEFAULT NULL,
    title VARCHAR(255) NULL DEFAULT NULL,
    bio TEXT NULL DEFAULT NULL,
    avatar_path VARCHAR(500) NULL DEFAULT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    meta JSONB NULL DEFAULT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT staff_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX staff_staff_tenant_email_unique ON staff (tenant_id, lower(email));

CREATE INDEX staff_staff_tenant_active_idx ON staff (tenant_id, is_active, sort_order);

-- Source MySQL migration: 007_create_service_staff.php
CREATE TABLE IF NOT EXISTS service_staff (
    service_id CHAR(26) NOT NULL,
    staff_id CHAR(26) NOT NULL,
    PRIMARY KEY (service_id, staff_id),
    CONSTRAINT service_staff_service_fk FOREIGN KEY (service_id) REFERENCES services (id) ON DELETE CASCADE,
    CONSTRAINT service_staff_staff_fk FOREIGN KEY (staff_id) REFERENCES staff (id) ON DELETE CASCADE
);

-- Source MySQL migration: 008_create_availability.php
CREATE TABLE IF NOT EXISTS availability (
    id CHAR(26) NOT NULL,
    tenant_id CHAR(26) NOT NULL,
    staff_id CHAR(26) NULL DEFAULT NULL,
    day_of_week SMALLINT NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    is_available BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (id),
    CONSTRAINT availability_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
    CONSTRAINT availability_staff_fk FOREIGN KEY (staff_id) REFERENCES staff (id) ON DELETE CASCADE
);

CREATE INDEX availability_availability_tenant_day_idx ON availability (tenant_id, day_of_week);

CREATE INDEX availability_availability_staff_day_idx ON availability (staff_id, day_of_week);

-- Source MySQL migration: 009_create_resources.php
CREATE TABLE IF NOT EXISTS resources (
    id CHAR(26) NOT NULL,
    tenant_id CHAR(26) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT NULL DEFAULT NULL,
    capacity INTEGER NOT NULL DEFAULT 1,
    cover_image_path VARCHAR(500) NULL DEFAULT NULL,
    amenities JSONB NULL DEFAULT NULL,
    price_per_night DECIMAL(10,2) NULL DEFAULT NULL,
    min_stay_nights INTEGER NOT NULL DEFAULT 1,
    max_stay_nights INTEGER NOT NULL DEFAULT 30,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT resources_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE INDEX resources_resources_tenant_active_idx ON resources (tenant_id, is_active, sort_order);

-- Source MySQL migration: 010_create_api_keys.php
CREATE TABLE IF NOT EXISTS api_keys (
    id CHAR(26) NOT NULL,
    name VARCHAR(255) NOT NULL,
    key_hash CHAR(64) NOT NULL,
    key_prefix CHAR(8) NOT NULL,
    scopes JSONB NOT NULL,
    role VARCHAR(10) NOT NULL DEFAULT 'viewer',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_used_at TIMESTAMP WITHOUT TIME ZONE NULL DEFAULT NULL,
    expires_at TIMESTAMP WITHOUT TIME ZONE NULL DEFAULT NULL,
    created_by CHAR(26) NULL DEFAULT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
);

CREATE UNIQUE INDEX api_keys_api_keys_hash_unique ON api_keys (key_hash);

CREATE INDEX api_keys_api_keys_prefix_idx ON api_keys (key_prefix);

CREATE INDEX api_keys_api_keys_active_idx ON api_keys (is_active);

-- Source MySQL migration: 011_create_business_users.php
CREATE TABLE IF NOT EXISTS business_users (
    id CHAR(26) NOT NULL,
    tenant_id CHAR(26) NOT NULL,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(10) NOT NULL DEFAULT 'manager',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    force_password_change BOOLEAN NOT NULL DEFAULT FALSE,
    last_login_at TIMESTAMP WITHOUT TIME ZONE NULL DEFAULT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT business_users_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX business_users_business_users_email_unique ON business_users (lower(email));

CREATE INDEX business_users_business_users_tenant_idx ON business_users (tenant_id);

CREATE INDEX business_users_business_users_active_idx ON business_users (tenant_id, is_active);

-- Source MySQL migration: 018_create_rate_limits.php
CREATE TABLE IF NOT EXISTS rate_limits (
    id BIGINT NOT NULL GENERATED BY DEFAULT AS IDENTITY,
    ip VARCHAR(45) NOT NULL,
    endpoint_group VARCHAR(50) NOT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
);

CREATE INDEX rate_limits_rate_limits_lookup ON rate_limits (ip, endpoint_group, created_at);

-- Source MySQL migration: 019_create_customers.php
CREATE TABLE IF NOT EXISTS customers (
    id CHAR(26) NOT NULL,
    tenant_id CHAR(26) NOT NULL,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NULL DEFAULT NULL,
    notes TEXT NULL DEFAULT NULL,
    profile_data JSONB NULL DEFAULT NULL,
    booking_count INTEGER NOT NULL DEFAULT 0,
    last_booking_at TIMESTAMP WITHOUT TIME ZONE NULL DEFAULT NULL,
    is_anonymized BOOLEAN NOT NULL DEFAULT FALSE,
    anonymized_at TIMESTAMP WITHOUT TIME ZONE NULL DEFAULT NULL,
    deletion_requested_at TIMESTAMP WITHOUT TIME ZONE NULL DEFAULT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT customers_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX customers_customers_tenant_email_unique ON customers (tenant_id, lower(email));

CREATE INDEX customers_customers_tenant_id_idx ON customers (tenant_id);

CREATE INDEX customers_customers_anonymized_idx ON customers (is_anonymized);

CREATE INDEX customers_customers_deletion_pending_idx ON customers (deletion_requested_at, is_anonymized);

-- Source MySQL migration: 020_create_bookings.php
CREATE TABLE IF NOT EXISTS bookings (
    id CHAR(26) NOT NULL,
    tenant_id CHAR(26) NOT NULL,
    booking_pattern VARCHAR(20) NOT NULL,
    service_id CHAR(26) NULL DEFAULT NULL,
    staff_id CHAR(26) NULL DEFAULT NULL,
    resource_id CHAR(26) NULL DEFAULT NULL,
    event_id CHAR(26) NULL DEFAULT NULL,
    customer_id CHAR(26) NOT NULL,
    start_datetime TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    end_datetime TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    party_size INTEGER NOT NULL DEFAULT 1,
    status VARCHAR(20) NOT NULL DEFAULT 'confirmed',
    rescheduled_to_id CHAR(26) NULL DEFAULT NULL,
    notes TEXT NULL DEFAULT NULL,
    internal_notes TEXT NULL DEFAULT NULL,
    custom_field_data JSONB NULL DEFAULT NULL,
    consent_given_at TIMESTAMP WITHOUT TIME ZONE NULL DEFAULT NULL,
    consent_text_shown VARCHAR(500) NULL DEFAULT NULL,
    customer_timezone VARCHAR(100) NULL DEFAULT NULL,
    confirmation_sent_at TIMESTAMP WITHOUT TIME ZONE NULL DEFAULT NULL,
    reminder_sent_at TIMESTAMP WITHOUT TIME ZONE NULL DEFAULT NULL,
    cancelled_at TIMESTAMP WITHOUT TIME ZONE NULL DEFAULT NULL,
    cancellation_reason VARCHAR(255) NULL DEFAULT NULL,
    source VARCHAR(10) NOT NULL DEFAULT 'web',
    meta JSONB NULL DEFAULT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT bookings_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
    CONSTRAINT bookings_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE
);

CREATE INDEX bookings_bookings_tenant_pattern_status_idx ON bookings (tenant_id, booking_pattern, status);

CREATE INDEX bookings_bookings_tenant_status_start_idx ON bookings (tenant_id, status, start_datetime);

CREATE INDEX bookings_bookings_customer_id_idx ON bookings (customer_id);

CREATE INDEX bookings_bookings_staff_start_idx ON bookings (staff_id, start_datetime);

CREATE INDEX bookings_bookings_resource_start_idx ON bookings (resource_id, start_datetime);

CREATE INDEX bookings_bookings_event_id_idx ON bookings (event_id);

-- Source MySQL migration: 020_create_bookings.php
CREATE TABLE IF NOT EXISTS reminders (
    id CHAR(26) NOT NULL,
    booking_id CHAR(26) NOT NULL,
    tenant_id CHAR(26) NOT NULL,
    scheduled_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    sent_at TIMESTAMP WITHOUT TIME ZONE NULL DEFAULT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error VARCHAR(500) NULL DEFAULT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT reminders_booking_fk FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE CASCADE,
    CONSTRAINT reminders_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE INDEX reminders_reminders_pending_idx ON reminders (sent_at, scheduled_at);

CREATE INDEX reminders_reminders_booking_idx ON reminders (booking_id);

-- Source MySQL migration: 021_create_email_log.php
CREATE TABLE IF NOT EXISTS email_log (
    id CHAR(26) NOT NULL,
    tenant_id CHAR(26) NULL DEFAULT NULL,
    booking_id CHAR(26) NULL DEFAULT NULL,
    type VARCHAR(30) NOT NULL,
    to_email VARCHAR(255) NOT NULL,
    subject VARCHAR(500) NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'sent',
    error TEXT NULL DEFAULT NULL,
    sent_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
);

CREATE INDEX email_log_email_log_tenant_idx ON email_log (tenant_id);

CREATE INDEX email_log_email_log_booking_idx ON email_log (booking_id);

CREATE INDEX email_log_email_log_sent_at_idx ON email_log (sent_at);

-- Source MySQL migration: 022_create_tenant_email_templates.php
CREATE TABLE IF NOT EXISTS tenant_email_templates (
    id CHAR(26) NOT NULL,
    tenant_id CHAR(26) NOT NULL,
    type VARCHAR(30) NOT NULL,
    subject VARCHAR(255) NULL DEFAULT NULL,
    heading VARCHAR(255) NULL DEFAULT NULL,
    body_intro TEXT NULL DEFAULT NULL,
    body_outro TEXT NULL DEFAULT NULL,
    cta_label VARCHAR(100) NULL DEFAULT NULL,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT tenant_email_templates_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX tenant_email_templates_tenant_email_templates_tenant_type_uniqu ON tenant_email_templates (tenant_id, type);

-- Source MySQL migration: 023_create_blocked_dates.php
CREATE TABLE IF NOT EXISTS blocked_dates (
    id CHAR(26) NOT NULL,
    tenant_id CHAR(26) NOT NULL,
    staff_id CHAR(26) NULL DEFAULT NULL,
    resource_id CHAR(26) NULL DEFAULT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    reason VARCHAR(255) NULL DEFAULT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT blocked_dates_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
    CONSTRAINT blocked_dates_staff_fk FOREIGN KEY (staff_id) REFERENCES staff (id) ON DELETE CASCADE,
    CONSTRAINT blocked_dates_resource_fk FOREIGN KEY (resource_id) REFERENCES resources (id) ON DELETE CASCADE
);

CREATE INDEX blocked_dates_blocked_dates_tenant_idx ON blocked_dates (tenant_id, start_date, end_date);

CREATE INDEX blocked_dates_blocked_dates_staff_idx ON blocked_dates (staff_id, start_date, end_date);

CREATE INDEX blocked_dates_blocked_dates_resource_idx ON blocked_dates (resource_id, start_date, end_date);

-- Source MySQL migration: 024_create_seasonal_pricing.php
CREATE TABLE IF NOT EXISTS seasonal_pricing (
    id CHAR(26) NOT NULL,
    resource_id CHAR(26) NOT NULL,
    tenant_id CHAR(26) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    price_per_night DECIMAL(10,2) NOT NULL,
    label VARCHAR(255) NULL DEFAULT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT seasonal_pricing_resource_fk FOREIGN KEY (resource_id) REFERENCES resources (id) ON DELETE CASCADE,
    CONSTRAINT seasonal_pricing_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE INDEX seasonal_pricing_seasonal_pricing_resource_dates_idx ON seasonal_pricing (resource_id, start_date, end_date);

CREATE INDEX seasonal_pricing_seasonal_pricing_tenant_idx ON seasonal_pricing (tenant_id);

-- Source MySQL migration: 025_create_capacity_slots.php
CREATE TABLE IF NOT EXISTS capacity_slots (
    id CHAR(26) NOT NULL,
    tenant_id CHAR(26) NOT NULL,
    day_of_week SMALLINT NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    max_capacity INTEGER NOT NULL DEFAULT 20,
    min_party_size INTEGER NOT NULL DEFAULT 1,
    max_party_size INTEGER NOT NULL DEFAULT 8,
    label VARCHAR(100) NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT fk_capacity_slots_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE INDEX capacity_slots_idx_capacity_slots_tenant ON capacity_slots (tenant_id);

CREATE INDEX capacity_slots_idx_capacity_slots_day ON capacity_slots (tenant_id, day_of_week, is_active);

CREATE UNIQUE INDEX capacity_slots_uq_capacity_slots_window ON capacity_slots (tenant_id, day_of_week, start_time, end_time);

-- Source MySQL migration: 026_create_events.php
CREATE TABLE IF NOT EXISTS events (
    id CHAR(26) NOT NULL,
    tenant_id CHAR(26) NOT NULL,
    name VARCHAR(200) NOT NULL,
    description TEXT NULL DEFAULT NULL,
    location VARCHAR(255) NULL DEFAULT NULL,
    price DECIMAL(10, 2) NULL DEFAULT NULL,
    max_participants INTEGER NOT NULL DEFAULT 20,
    min_spot_count INTEGER NOT NULL DEFAULT 1,
    max_spot_count INTEGER NULL DEFAULT NULL,
    start_datetime TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    end_datetime TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    is_recurring BOOLEAN NOT NULL DEFAULT FALSE,
    rrule VARCHAR(500) NULL DEFAULT NULL,
    exception_dates JSONB NULL DEFAULT NULL,
    allow_waitlist BOOLEAN NOT NULL DEFAULT FALSE,
    waitlist_max INTEGER NOT NULL DEFAULT 5,
    cover_image_path VARCHAR(500) NULL DEFAULT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT events_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE INDEX events_events_tenant_active_idx ON events (tenant_id, is_active, start_datetime);

-- Source MySQL migration: 027_add_resource_checkin_checkout_days.php
ALTER TABLE resources
        ADD COLUMN check_in_days JSONB NULL,
        ADD COLUMN check_out_days JSONB NULL;

-- Source MySQL migration: 028_create_business_applications.php
CREATE TABLE IF NOT EXISTS business_applications (
    id CHAR(26) NOT NULL,
    business_name VARCHAR(255) NOT NULL,
    contact_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NULL DEFAULT NULL,
    website VARCHAR(255) NULL DEFAULT NULL,
    message TEXT NULL DEFAULT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    admin_notes TEXT NULL DEFAULT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    reviewed_at TIMESTAMP WITHOUT TIME ZONE NULL DEFAULT NULL,
    reviewed_by CHAR(26) NULL DEFAULT NULL,
    PRIMARY KEY (id)
);

CREATE INDEX business_applications_idx_ba_status ON business_applications (status);

CREATE INDEX business_applications_idx_ba_created ON business_applications (created_at);

-- Source MySQL migration: 029_agent_rate_budgets.php
CREATE TABLE IF NOT EXISTS agent_rate_budgets (
    budget_key CHAR(64) NOT NULL,
    window_start BIGINT NOT NULL,
    attempts BIGINT NOT NULL DEFAULT 0,
    expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    PRIMARY KEY (budget_key, window_start)
);

CREATE INDEX agent_rate_budgets_agent_rate_expiry ON agent_rate_budgets (expires_at);

-- Source MySQL migration: 030_agent_connections.php
CREATE TABLE IF NOT EXISTS agent_connections (
    id CHAR(26) NOT NULL PRIMARY KEY,
    principal_type VARCHAR(20) NOT NULL,
    principal_id CHAR(26) NOT NULL,
    identity_hash CHAR(64) NOT NULL,
    customer_capability_id CHAR(26) NULL,
    name VARCHAR(120) NOT NULL,
    scopes JSONB NOT NULL,
    business_ids JSONB NOT NULL,
    client_id VARCHAR(512) NULL,
    purpose VARCHAR(500) NOT NULL,
    expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    revoked_at TIMESTAMP WITHOUT TIME ZONE NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    last_used_at TIMESTAMP WITHOUT TIME ZONE NULL
);

CREATE INDEX agent_connections_connection_principal ON agent_connections (principal_type, principal_id);

CREATE INDEX agent_connections_connection_expiry ON agent_connections (expires_at);

-- Source MySQL migration: 030_agent_connections.php
CREATE TABLE IF NOT EXISTS agent_credentials (
    id CHAR(26) NOT NULL PRIMARY KEY,
    connection_id CHAR(26) NOT NULL,
    token_hash CHAR(64) NOT NULL,
    prefix VARCHAR(12) NOT NULL,
    audience VARCHAR(512) NOT NULL,
    scopes JSONB NULL,
    expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    revoked_at TIMESTAMP WITHOUT TIME ZONE NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    CONSTRAINT credential_connection_fk FOREIGN KEY (connection_id) REFERENCES agent_connections (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX agent_credentials_credential_hash ON agent_credentials (token_hash);

CREATE INDEX agent_credentials_credential_connection ON agent_credentials (connection_id);

-- Source MySQL migration: 031_agent_operations.php
CREATE TABLE IF NOT EXISTS agent_operation_receipts (
    id CHAR(26) NOT NULL PRIMARY KEY,
    dedupe_hash CHAR(64) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    principal_type VARCHAR(20) NOT NULL,
    principal_id VARCHAR(128) NOT NULL,
    connection_id CHAR(26) NULL,
    credential_id CHAR(26) NULL,
    tenant_id CHAR(26) NULL,
    operation_id VARCHAR(100) NOT NULL,
    result_cipher TEXT NULL,
    resource_id CHAR(26) NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    replay_until TIMESTAMP WITHOUT TIME ZONE NOT NULL
);

CREATE UNIQUE INDEX agent_operation_receipts_receipt_dedupe ON agent_operation_receipts (dedupe_hash);

CREATE INDEX agent_operation_receipts_receipt_principal ON agent_operation_receipts (principal_type, principal_id);

CREATE INDEX agent_operation_receipts_receipt_tenant ON agent_operation_receipts (tenant_id);

CREATE INDEX agent_operation_receipts_receipt_retention ON agent_operation_receipts (replay_until);

-- Source MySQL migration: 031_agent_operations.php
CREATE TABLE IF NOT EXISTS agent_previews (
    id CHAR(26) NOT NULL PRIMARY KEY,
    handle_hash CHAR(64) NOT NULL,
    principal_type VARCHAR(20) NOT NULL,
    principal_id VARCHAR(128) NOT NULL,
    connection_id CHAR(26) NULL,
    credential_id CHAR(26) NULL,
    tenant_id CHAR(26) NULL,
    operation_id VARCHAR(100) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    payload_cipher TEXT NOT NULL,
    review_cipher TEXT NOT NULL,
    approved_at TIMESTAMP WITHOUT TIME ZONE NULL,
    approval_source VARCHAR(30) NULL,
    consumed_at TIMESTAMP WITHOUT TIME ZONE NULL,
    expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL
);

CREATE UNIQUE INDEX agent_previews_preview_handle ON agent_previews (handle_hash);

CREATE INDEX agent_previews_preview_expiry ON agent_previews (expires_at);

-- Source MySQL migration: 032_oauth.php
CREATE TABLE IF NOT EXISTS oauth_clients (
    id VARCHAR(512) NOT NULL PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    redirect_uris JSONB NOT NULL,
    secret_hash VARCHAR(255) NULL,
    auth_method VARCHAR(30) NOT NULL,
    registration_type VARCHAR(20) NOT NULL,
    metadata_expires_at TIMESTAMP WITHOUT TIME ZONE NULL,
    revoked_at TIMESTAMP WITHOUT TIME ZONE NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL
);

CREATE INDEX oauth_clients_oauth_client_expiry ON oauth_clients (metadata_expires_at);

-- Source MySQL migration: 032_oauth.php
CREATE TABLE IF NOT EXISTS oauth_grants (
    connection_id CHAR(26) NOT NULL PRIMARY KEY,
    audience VARCHAR(512) NOT NULL,
    CONSTRAINT oauth_grant_connection_fk FOREIGN KEY (connection_id) REFERENCES agent_connections(id) ON DELETE CASCADE
);

-- Source MySQL migration: 032_oauth.php
CREATE TABLE IF NOT EXISTS oauth_auth_codes (
    id_hash CHAR(64) NOT NULL PRIMARY KEY,
    connection_id CHAR(26) NOT NULL,
    expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    revoked_at TIMESTAMP WITHOUT TIME ZONE NULL,
    CONSTRAINT oauth_code_connection_fk FOREIGN KEY (connection_id) REFERENCES agent_connections(id) ON DELETE CASCADE
);

CREATE INDEX oauth_auth_codes_oauth_code_expiry ON oauth_auth_codes (expires_at);

-- Source MySQL migration: 032_oauth.php
CREATE TABLE IF NOT EXISTS oauth_access_tokens (
    id_hash CHAR(64) NOT NULL PRIMARY KEY,
    connection_id CHAR(26) NOT NULL,
    credential_id CHAR(26) NOT NULL,
    expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    revoked_at TIMESTAMP WITHOUT TIME ZONE NULL,
    CONSTRAINT oauth_access_connection_fk FOREIGN KEY (connection_id) REFERENCES agent_connections(id) ON DELETE CASCADE,
    CONSTRAINT oauth_access_credential_fk FOREIGN KEY (credential_id) REFERENCES agent_credentials(id) ON DELETE CASCADE
);

CREATE INDEX oauth_access_tokens_oauth_access_expiry ON oauth_access_tokens (expires_at);

-- Source MySQL migration: 032_oauth.php
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
    id_hash CHAR(64) NOT NULL PRIMARY KEY,
    connection_id CHAR(26) NOT NULL,
    access_id_hash CHAR(64) NOT NULL,
    expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    revoked_at TIMESTAMP WITHOUT TIME ZONE NULL,
    CONSTRAINT oauth_refresh_connection_fk FOREIGN KEY (connection_id) REFERENCES agent_connections(id) ON DELETE CASCADE
);

CREATE INDEX oauth_refresh_tokens_oauth_refresh_expiry ON oauth_refresh_tokens (expires_at);

-- Source MySQL migration: 033_delivery_outbox.php
CREATE TABLE IF NOT EXISTS delivery_outbox (
    id CHAR(26) NOT NULL PRIMARY KEY,
    topic VARCHAR(100) NOT NULL,
    tenant_id CHAR(26) NULL,
    operation_receipt_id CHAR(26) NULL,
    dedupe_hash CHAR(64) NOT NULL,
    payload_cipher TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    attempts SMALLINT NOT NULL DEFAULT 0,
    available_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    lease_until TIMESTAMP WITHOUT TIME ZONE NULL,
    lease_token CHAR(64) NULL,
    delivered_at TIMESTAMP WITHOUT TIME ZONE NULL,
    last_error_code VARCHAR(60) NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL
);

CREATE UNIQUE INDEX delivery_outbox_outbox_dedupe ON delivery_outbox (dedupe_hash);

CREATE INDEX delivery_outbox_outbox_ready ON delivery_outbox (status, available_at, lease_until);

CREATE INDEX delivery_outbox_outbox_tenant ON delivery_outbox (tenant_id);

CREATE INDEX delivery_outbox_outbox_receipt ON delivery_outbox (operation_receipt_id);

-- Source MySQL migration: 035_media_grants.php
CREATE TABLE IF NOT EXISTS agent_media_grants (
    id CHAR(26) NOT NULL PRIMARY KEY,
    tenant_id CHAR(26) NOT NULL,
    principal_type VARCHAR(20) NOT NULL,
    principal_id VARCHAR(128) NOT NULL,
    connection_id CHAR(26) NULL,
    credential_id CHAR(26) NULL,
    identity_hash CHAR(64) NOT NULL,
    purpose VARCHAR(20) NOT NULL,
    token_hash CHAR(64) NOT NULL,
    path VARCHAR(500) NULL,
    content_hash CHAR(64) NULL,
    consumed_at TIMESTAMP WITHOUT TIME ZONE NULL,
    expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL
);

CREATE INDEX agent_media_grants_media_tenant ON agent_media_grants (tenant_id);

CREATE INDEX agent_media_grants_media_expiry ON agent_media_grants (expires_at);

INSERT INTO settings (key,value) VALUES ('system_settings_revision','0') ON CONFLICT (key) DO NOTHING;

-- Source MySQL migration: 038_system_jobs.php
CREATE TABLE IF NOT EXISTS system_job_requests (
    id CHAR(26) NOT NULL PRIMARY KEY,
    status VARCHAR(20) NOT NULL DEFAULT 'queued',
    jobs_json JSONB NOT NULL,
    principal_type VARCHAR(20) NOT NULL,
    principal_id VARCHAR(128) NOT NULL,
    connection_id CHAR(26) NULL,
    credential_id CHAR(26) NULL,
    auth_mode VARCHAR(30) NOT NULL,
    requested_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    started_at TIMESTAMP WITHOUT TIME ZONE NULL,
    finished_at TIMESTAMP WITHOUT TIME ZONE NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    results_json JSONB NULL,
    last_error_code VARCHAR(80) NULL
);

CREATE INDEX system_job_requests_jobs_status ON system_job_requests (status,requested_at);

-- Source MySQL migration: 039_webhooks.php
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
    id CHAR(26) NOT NULL PRIMARY KEY,
    tenant_id CHAR(26) NOT NULL,
    name VARCHAR(100) NOT NULL,
    endpoint VARCHAR(2048) NOT NULL,
    event_types JSONB NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    secret_cipher TEXT NOT NULL,
    previous_secret_cipher TEXT NULL,
    previous_secret_until TIMESTAMP WITHOUT TIME ZONE NULL,
    secret_revealed_at TIMESTAMP WITHOUT TIME ZONE NULL,
    generation INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL
);

CREATE INDEX webhook_subscriptions_webhook_business ON webhook_subscriptions (tenant_id,is_active,id);

-- Source MySQL migration: 039_webhooks.php
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id CHAR(26) NOT NULL PRIMARY KEY,
    tenant_id CHAR(26) NOT NULL,
    subscription_id CHAR(26) NOT NULL,
    event_id CHAR(26) NOT NULL,
    event_type VARCHAR(80) NOT NULL,
    payload_cipher TEXT NULL,
    outbox_id CHAR(26) NULL,
    last_http_status SMALLINT NULL,
    last_error_code VARCHAR(80) NULL,
    last_attempt_at TIMESTAMP WITHOUT TIME ZONE NULL,
    manual_retries SMALLINT NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL
);

CREATE UNIQUE INDEX webhook_deliveries_webhook_event ON webhook_deliveries (subscription_id,event_id);

CREATE INDEX webhook_deliveries_webhook_delivery_business ON webhook_deliveries (tenant_id,id);

CREATE INDEX webhook_deliveries_webhook_delivery_subscription ON webhook_deliveries (subscription_id,id);

-- Source MySQL migration: 041_customer_capabilities.php
CREATE TABLE IF NOT EXISTS customer_capabilities (
    id CHAR(26) NOT NULL PRIMARY KEY,
    token_hash CHAR(64) NOT NULL,
    purpose VARCHAR(32) NOT NULL,
    tenant_id CHAR(26) NOT NULL,
    subject_id CHAR(26) NOT NULL,
    customer_id CHAR(26) NOT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    revoked_at TIMESTAMP WITHOUT TIME ZONE NULL
);

CREATE UNIQUE INDEX customer_capabilities_uq_customer_capability_hash ON customer_capabilities (token_hash);

CREATE INDEX customer_capabilities_idx_customer_capability_subject ON customer_capabilities (tenant_id, purpose, subject_id);

CREATE INDEX customer_capabilities_idx_customer_capability_customer ON customer_capabilities (tenant_id, customer_id);

CREATE INDEX customer_capabilities_idx_customer_capability_expiry ON customer_capabilities (expires_at);

-- Source MySQL migration: 041_customer_capabilities.php
CREATE TABLE IF NOT EXISTS customer_recovery_limits (
    bucket_hash CHAR(64) NOT NULL PRIMARY KEY,
    attempts INTEGER NOT NULL,
    expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL
);

CREATE INDEX customer_recovery_limits_idx_customer_recovery_expiry ON customer_recovery_limits (expires_at);

-- Final-state columns from MySQL migration 034.
ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS customer_name_snapshot VARCHAR(255),
    ADD COLUMN IF NOT EXISTS customer_email_snapshot VARCHAR(255),
    ADD COLUMN IF NOT EXISTS customer_phone_snapshot VARCHAR(50),
    ADD COLUMN IF NOT EXISTS capacity_slot_id CHAR(26),
    ADD COLUMN IF NOT EXISTS price_total DECIMAL(12,2),
    ADD COLUMN IF NOT EXISTS price_currency CHAR(3);

-- Final-state preview review secret from MySQL migration 042.
ALTER TABLE agent_previews ADD COLUMN IF NOT EXISTS review_hash CHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_preview_review ON agent_previews (review_hash);

CREATE TRIGGER settings_set_updated_at BEFORE UPDATE ON settings FOR EACH ROW EXECUTE FUNCTION voxelbooking_set_updated_at();

CREATE TRIGGER operators_set_updated_at BEFORE UPDATE ON operators FOR EACH ROW EXECUTE FUNCTION voxelbooking_set_updated_at();

CREATE TRIGGER tenants_set_updated_at BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION voxelbooking_set_updated_at();

CREATE TRIGGER services_set_updated_at BEFORE UPDATE ON services FOR EACH ROW EXECUTE FUNCTION voxelbooking_set_updated_at();

CREATE TRIGGER staff_set_updated_at BEFORE UPDATE ON staff FOR EACH ROW EXECUTE FUNCTION voxelbooking_set_updated_at();

CREATE TRIGGER resources_set_updated_at BEFORE UPDATE ON resources FOR EACH ROW EXECUTE FUNCTION voxelbooking_set_updated_at();

CREATE TRIGGER api_keys_set_updated_at BEFORE UPDATE ON api_keys FOR EACH ROW EXECUTE FUNCTION voxelbooking_set_updated_at();

CREATE TRIGGER business_users_set_updated_at BEFORE UPDATE ON business_users FOR EACH ROW EXECUTE FUNCTION voxelbooking_set_updated_at();

CREATE TRIGGER customers_set_updated_at BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION voxelbooking_set_updated_at();

CREATE TRIGGER bookings_set_updated_at BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION voxelbooking_set_updated_at();

CREATE TRIGGER tenant_email_templates_set_updated_at BEFORE UPDATE ON tenant_email_templates FOR EACH ROW EXECUTE FUNCTION voxelbooking_set_updated_at();

CREATE TRIGGER capacity_slots_set_updated_at BEFORE UPDATE ON capacity_slots FOR EACH ROW EXECUTE FUNCTION voxelbooking_set_updated_at();

CREATE TRIGGER events_set_updated_at BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION voxelbooking_set_updated_at();
