export interface SegmentRule {
  type:
    | 'tag_exists'
    | 'tag_not_exists'
    | 'metadata_equals'
    | 'metadata_not_equals'
    | 'ref_code'
    | 'is_following'
    | 'group_exists'
    | 'group_not_exists'
    // ⑮ Per-friend status
    | 'friend_status'
    // ⑳ Assigned staff
    | 'assigned_staff'
    // ㉜ Shopify tag segment
    | 'shopify_tag_exists'
    | 'shopify_tag_not_exists'
    // ㉜ Shopify purchase-based segments
    | 'shopify_total_spent_gte'
    | 'shopify_orders_count_gte'
  value: string | boolean | number | { key: string; value: string }
}

export interface SegmentCondition {
  operator: 'AND' | 'OR'
  rules: SegmentRule[]
}

export function buildSegmentQuery(condition: SegmentCondition): { sql: string; bindings: unknown[] } {
  const bindings: unknown[] = []
  const clauses: string[] = []

  for (const rule of condition.rules) {
    switch (rule.type) {
      case 'tag_exists': {
        if (typeof rule.value !== 'string') {
          throw new Error('tag_exists rule requires a string tag ID value')
        }
        clauses.push(
          `EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)`,
        )
        bindings.push(rule.value)
        break
      }

      case 'tag_not_exists': {
        if (typeof rule.value !== 'string') {
          throw new Error('tag_not_exists rule requires a string tag ID value')
        }
        clauses.push(
          `NOT EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)`,
        )
        bindings.push(rule.value)
        break
      }

      case 'metadata_equals': {
        if (
          typeof rule.value !== 'object' ||
          rule.value === null ||
          typeof (rule.value as { key: string; value: string }).key !== 'string' ||
          typeof (rule.value as { key: string; value: string }).value !== 'string'
        ) {
          throw new Error('metadata_equals rule requires { key: string; value: string }')
        }
        const mv = rule.value as { key: string; value: string }
        clauses.push(`json_extract(f.metadata, ?) = ?`)
        bindings.push(`$.${mv.key}`, mv.value)
        break
      }

      case 'metadata_not_equals': {
        if (
          typeof rule.value !== 'object' ||
          rule.value === null ||
          typeof (rule.value as { key: string; value: string }).key !== 'string' ||
          typeof (rule.value as { key: string; value: string }).value !== 'string'
        ) {
          throw new Error('metadata_not_equals rule requires { key: string; value: string }')
        }
        const mv = rule.value as { key: string; value: string }
        clauses.push(`(json_extract(f.metadata, ?) IS NULL OR json_extract(f.metadata, ?) != ?)`)
        bindings.push(`$.${mv.key}`, `$.${mv.key}`, mv.value)
        break
      }

      case 'ref_code': {
        if (typeof rule.value !== 'string') {
          throw new Error('ref_code rule requires a string value')
        }
        clauses.push(`f.ref_code = ?`)
        bindings.push(rule.value)
        break
      }

      case 'is_following': {
        if (typeof rule.value !== 'boolean') {
          throw new Error('is_following rule requires a boolean value')
        }
        clauses.push(`f.is_following = ?`)
        bindings.push(rule.value ? 1 : 0)
        break
      }

      case 'group_exists': {
        if (typeof rule.value !== 'string') {
          throw new Error('group_exists rule requires a string group ID value')
        }
        clauses.push(
          `EXISTS (SELECT 1 FROM friend_groups fg WHERE fg.friend_id = f.id AND fg.group_id = ?)`,
        )
        bindings.push(rule.value)
        break
      }

      case 'group_not_exists': {
        if (typeof rule.value !== 'string') {
          throw new Error('group_not_exists rule requires a string group ID value')
        }
        clauses.push(
          `NOT EXISTS (SELECT 1 FROM friend_groups fg WHERE fg.friend_id = f.id AND fg.group_id = ?)`,
        )
        bindings.push(rule.value)
        break
      }

      // ⑮ Per-friend ステータス管理
      case 'friend_status': {
        if (typeof rule.value !== 'string') {
          throw new Error('friend_status rule requires a string status value')
        }
        clauses.push(`COALESCE(f.status, 'none') = ?`)
        bindings.push(rule.value)
        break
      }

      // ⑳ 担当者割り当て
      case 'assigned_staff': {
        if (typeof rule.value !== 'string') {
          throw new Error('assigned_staff rule requires a string staff ID value')
        }
        clauses.push(`f.assigned_staff_id = ?`)
        bindings.push(rule.value)
        break
      }

      // ㉜ Shopify タグ連携セグメント — タグがCSVに含まれるか
      case 'shopify_tag_exists': {
        if (typeof rule.value !== 'string') {
          throw new Error('shopify_tag_exists rule requires a string tag name')
        }
        // shopify_customers.tags is comma-separated (e.g. "VIP, リピーター, 定期")
        // Use LIKE with comma boundaries to avoid partial matches
        clauses.push(
          `EXISTS (SELECT 1 FROM shopify_customers sc WHERE sc.friend_id = f.id AND (',' || REPLACE(sc.tags, ' ', '') || ',') LIKE '%,' || REPLACE(?, ' ', '') || ',%')`,
        )
        bindings.push(rule.value)
        break
      }

      case 'shopify_tag_not_exists': {
        if (typeof rule.value !== 'string') {
          throw new Error('shopify_tag_not_exists rule requires a string tag name')
        }
        clauses.push(
          `NOT EXISTS (SELECT 1 FROM shopify_customers sc WHERE sc.friend_id = f.id AND (',' || REPLACE(sc.tags, ' ', '') || ',') LIKE '%,' || REPLACE(?, ' ', '') || ',%')`,
        )
        bindings.push(rule.value)
        break
      }

      // ㉜ Shopify 購入金額ベースセグメント
      case 'shopify_total_spent_gte': {
        if (typeof rule.value !== 'number') {
          throw new Error('shopify_total_spent_gte rule requires a numeric value')
        }
        clauses.push(
          `EXISTS (SELECT 1 FROM shopify_customers sc WHERE sc.friend_id = f.id AND sc.total_spent >= ?)`,
        )
        bindings.push(rule.value)
        break
      }

      // ㉜ Shopify 注文回数ベースセグメント
      case 'shopify_orders_count_gte': {
        if (typeof rule.value !== 'number') {
          throw new Error('shopify_orders_count_gte rule requires a numeric value')
        }
        clauses.push(
          `EXISTS (SELECT 1 FROM shopify_customers sc WHERE sc.friend_id = f.id AND sc.orders_count >= ?)`,
        )
        bindings.push(rule.value)
        break
      }

      default: {
        const exhaustive: never = rule.type
        throw new Error(`Unknown segment rule type: ${exhaustive}`)
      }
    }
  }

  const separator = condition.operator === 'AND' ? ' AND ' : ' OR '
  const where = clauses.length > 0 ? clauses.join(separator) : '1=1'
  // ブラックリスト除外（全配信で自動適用）
  const sql = `SELECT f.id, f.line_user_id FROM friends f WHERE COALESCE(f.is_blacklisted, 0) = 0 AND (${where})`

  return { sql, bindings }
}
