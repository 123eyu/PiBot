; Private names retain their # prefix in both definitions and uses.
(method_definition name: (private_property_identifier) @name) @definition.method
(call_expression function: (member_expression property: (private_property_identifier) @name)) @reference.call
