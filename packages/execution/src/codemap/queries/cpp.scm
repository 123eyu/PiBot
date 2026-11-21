; Keep the terminal name so qualified and templated calls join ordinary definition names.
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (field_expression field: (field_identifier) @name)) @reference.call
(call_expression function: (template_function name: (identifier) @name)) @reference.call
(call_expression function: (field_expression field: (template_method name: (field_identifier) @name))) @reference.call
(call_expression function: (qualified_identifier name: [
  (identifier) @name
  (template_function name: (identifier) @name)
  (qualified_identifier name: [
    (identifier) @name
    (template_function name: (identifier) @name)
  ])
])) @reference.call
