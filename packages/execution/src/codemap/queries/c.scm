; Upstream tags cover declarations only; these are spelling-level call sites, not resolved types.
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (field_expression field: (field_identifier) @name)) @reference.call
(call_expression function: (parenthesized_expression (identifier) @name)) @reference.call
