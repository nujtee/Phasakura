-- Migration 0010: RBAC reference data (roles, permission catalogue, default role grants)
--
-- This is system reference data required in every environment (not dev seed).
-- No user account and no password is created here. The first SUPER_ADMIN is
-- bootstrapped in Phase 3 via a one-time CLI command.

-- ---------------------------------------------------------------------------
-- Roles (spec §29)
-- ---------------------------------------------------------------------------
INSERT INTO roles (id, code, is_system, sort_order) VALUES
  ('role_super_admin',   'SUPER_ADMIN',   1, 1),
  ('role_manager',       'MANAGER',       1, 2),
  ('role_booking_admin', 'BOOKING_ADMIN', 1, 3),
  ('role_finance_admin', 'FINANCE_ADMIN', 1, 4),
  ('role_content_admin', 'CONTENT_ADMIN', 1, 5),
  ('role_viewer',        'VIEWER',        1, 6);

INSERT INTO role_translations (role_id, language_code, name, description) VALUES
  ('role_super_admin',   'th', 'ผู้ดูแลระบบสูงสุด', 'สิทธิ์ทั้งหมด รวมถึงจัดการผู้ใช้ บทบาท และสิทธิ์'),
  ('role_super_admin',   'en', 'Super Admin', 'Full access including users, roles and permissions'),
  ('role_super_admin',   'zh-CN', '超级管理员', '全部权限，包括用户、角色与权限管理'),
  ('role_manager',       'th', 'ผู้จัดการ', 'ดูแลการดำเนินงานทั้งหมด ยกเว้นการจัดการสิทธิ์ผู้ใช้'),
  ('role_manager',       'en', 'Manager', 'All operations except user permission management'),
  ('role_manager',       'zh-CN', '经理', '除用户权限管理外的全部运营功能'),
  ('role_booking_admin', 'th', 'ผู้ดูแลการจอง', 'จัดการการจอง ปฏิทิน และคำสั่งอาหาร'),
  ('role_booking_admin', 'en', 'Booking Admin', 'Bookings, calendar and food orders'),
  ('role_booking_admin', 'zh-CN', '预订管理员', '预订、日历与餐饮订单'),
  ('role_finance_admin', 'th', 'ผู้ดูแลการเงิน', 'ตรวจสลิป การชำระเงิน บัญชีรับเงิน และรายงาน'),
  ('role_finance_admin', 'en', 'Finance Admin', 'Slips, payments, receiving accounts and reports'),
  ('role_finance_admin', 'zh-CN', '财务管理员', '转账凭证、付款、收款账户与报表'),
  ('role_content_admin', 'th', 'ผู้ดูแลเนื้อหา', 'จัดการเนื้อหาเว็บไซต์ แกลเลอรี ประวัติ SEO และธีม'),
  ('role_content_admin', 'en', 'Content Admin', 'Website content, gallery, history, SEO and theme'),
  ('role_content_admin', 'zh-CN', '内容管理员', '网站内容、图库、历史、SEO 与主题'),
  ('role_viewer',        'th', 'ผู้ดูข้อมูล', 'ดูข้อมูลได้อย่างเดียว'),
  ('role_viewer',        'en', 'Viewer', 'Read-only access'),
  ('role_viewer',        'zh-CN', '只读用户', '仅可查看');

-- ---------------------------------------------------------------------------
-- Permission catalogue. id = 'perm_' || code with '.' → '_'.
-- ---------------------------------------------------------------------------
INSERT INTO permissions (id, code, module, description) VALUES
  ('perm_dashboard_view',               'dashboard.view',               'dashboard',     'View dashboard'),
  ('perm_bookings_view',                'bookings.view',                'bookings',      'View bookings'),
  ('perm_bookings_create',              'bookings.create',              'bookings',      'Create bookings on behalf of customers'),
  ('perm_bookings_edit',                'bookings.edit',                'bookings',      'Edit bookings'),
  ('perm_bookings_cancel',              'bookings.cancel',              'bookings',      'Cancel bookings'),
  ('perm_bookings_export',              'bookings.export',              'bookings',      'Export booking data'),
  ('perm_calendar_view',                'calendar.view',                'bookings',      'View booking calendar'),
  ('perm_accommodation_view',           'accommodation.view',           'accommodation', 'View houses and VIP tents'),
  ('perm_accommodation_edit',           'accommodation.edit',           'accommodation', 'Create/edit houses and VIP tents'),
  ('perm_accommodation_block',          'accommodation.block',          'accommodation', 'Block dates for maintenance'),
  ('perm_pricing_edit',                 'pricing.edit',                 'accommodation', 'Change prices and pricing rules'),
  ('perm_camping_view',                 'camping.view',                 'accommodation', 'View camping settings and capacity'),
  ('perm_camping_edit',                 'camping.edit',                 'accommodation', 'Edit camping settings and capacity'),
  ('perm_food_view',                    'food.view',                    'food',          'View food menu'),
  ('perm_food_edit',                    'food.edit',                    'food',          'Edit food menu, included meals, capacity, deadlines'),
  ('perm_food_orders_view',             'food_orders.view',             'food',          'View food orders'),
  ('perm_food_orders_manage',           'food_orders.manage',           'food',          'Update food order status'),
  ('perm_kitchen_view',                 'kitchen.view',                 'food',          'View kitchen report'),
  ('perm_payments_view',                'payments.view',                'finance',       'View payments'),
  ('perm_payments_verify',              'payments.verify',              'finance',       'Verify or reject payments'),
  ('perm_payments_refund',              'payments.refund',              'finance',       'Record refunds'),
  ('perm_slips_view',                   'slips.view',                   'finance',       'View payment slip images'),
  ('perm_receiving_accounts_view',      'receiving_accounts.view',      'finance',       'View receiving accounts'),
  ('perm_receiving_accounts_edit',      'receiving_accounts.edit',      'finance',       'Edit receiving accounts'),
  ('perm_reports_view',                 'reports.view',                 'reports',       'View reports'),
  ('perm_reports_export',               'reports.export',               'reports',       'Export reports (Excel/PDF)'),
  ('perm_content_view',                 'content.view',                 'content',       'View website content in admin'),
  ('perm_content_home',                 'content.home',                 'content',       'Edit home page and hero slides'),
  ('perm_content_gallery',              'content.gallery',              'content',       'Manage gallery'),
  ('perm_content_history',              'content.history',              'content',       'Manage history page'),
  ('perm_content_publish',              'content.publish',              'content',       'Publish/unpublish website content'),
  ('perm_seo_edit',                     'seo.edit',                     'content',       'Edit SEO settings and redirects'),
  ('perm_marketing_view',               'marketing.view',               'marketing',     'View marketing settings'),
  ('perm_marketing_edit',               'marketing.edit',               'marketing',     'Edit GA4 / Meta Pixel / CAPI settings'),
  ('perm_settings_website',             'settings.website',             'settings',      'Edit website settings'),
  ('perm_settings_branding',            'settings.branding',            'settings',      'Change logos and favicon'),
  ('perm_settings_theme',               'settings.theme',               'settings',      'Edit and publish theme'),
  ('perm_settings_booking_cta',         'settings.booking_cta',         'settings',      'Edit floating booking button'),
  ('perm_settings_line',                'settings.line',                'settings',      'Edit LINE notification settings'),
  ('perm_settings_privacy',             'settings.privacy',             'settings',      'Edit privacy and cookie settings'),
  ('perm_users_view',                   'users.view',                   'users',         'View admin users'),
  ('perm_users_create',                 'users.create',                 'users',         'Create admin users'),
  ('perm_users_edit',                   'users.edit',                   'users',         'Edit admin users'),
  ('perm_users_delete',                 'users.delete',                 'users',         'Soft-delete admin users'),
  ('perm_users_manage_roles',           'users.manage_roles',           'users',         'Assign roles'),
  ('perm_users_manage_permissions',     'users.manage_permissions',     'users',         'Grant/deny individual permissions'),
  ('perm_users_reset_password',         'users.reset_password',         'users',         'Reset user passwords'),
  ('perm_users_suspend',                'users.suspend',                'users',         'Suspend/activate users'),
  ('perm_users_force_logout',           'users.force_logout',           'users',         'Revoke user sessions'),
  ('perm_users_restore',                'users.restore',                'users',         'Restore deleted users'),
  ('perm_roles_view',                   'roles.view',                   'users',         'View roles and their permissions'),
  ('perm_security_events_view',         'security_events.view',         'security',      'View security events'),
  ('perm_audit_logs_view',              'audit_logs.view',              'security',      'View audit logs'),
  ('perm_notifications_view',           'notifications.view',           'settings',      'View notification logs');

-- ---------------------------------------------------------------------------
-- Default grants (editable later by SUPER_ADMIN through the admin UI)
-- ---------------------------------------------------------------------------

-- SUPER_ADMIN: everything.
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_super_admin', id FROM permissions;

-- MANAGER: everything except managing users, roles and permissions (may view users).
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_manager', id FROM permissions
 WHERE module <> 'users' OR code IN ('users.view', 'roles.view');

INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_booking_admin', id FROM permissions WHERE code IN (
  'dashboard.view', 'bookings.view', 'bookings.create', 'bookings.edit', 'bookings.cancel', 'calendar.view',
  'accommodation.view', 'accommodation.block', 'camping.view', 'food.view', 'food_orders.view',
  'food_orders.manage', 'kitchen.view', 'payments.view');

INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_finance_admin', id FROM permissions WHERE code IN (
  'dashboard.view', 'bookings.view', 'bookings.export', 'calendar.view', 'payments.view', 'payments.verify',
  'payments.refund', 'slips.view', 'receiving_accounts.view', 'receiving_accounts.edit', 'reports.view',
  'reports.export');

INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_content_admin', id FROM permissions WHERE code IN (
  'dashboard.view', 'accommodation.view', 'food.view', 'content.view', 'content.home', 'content.gallery',
  'content.history', 'content.publish', 'seo.edit', 'settings.branding', 'settings.theme',
  'settings.booking_cta');

-- VIEWER: read-only operational views. No slips (payment PII), no users, no security logs.
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_viewer', id FROM permissions WHERE code IN (
  'dashboard.view', 'bookings.view', 'calendar.view', 'accommodation.view', 'camping.view', 'food.view',
  'food_orders.view', 'kitchen.view', 'payments.view', 'reports.view', 'content.view');
