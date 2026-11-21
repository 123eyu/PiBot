-- The direct dispatcher defines origin. An inherited user_message_id is only ancestry.
-- Older rows without a retained original assignment run cannot prove their dispatcher.
UPDATE group_task_sources SET
 kind='unknown', message_id=NULL, conversation_id=NULL, batch_message_id=NULL
WHERE NOT EXISTS (
 SELECT 1 FROM group_tasks t JOIN runs child ON child.task_id=t.id AND child.kind='group_task'
 JOIN runs parent ON parent.id=child.parent_run_id AND parent.group_id=t.group_id
   AND parent.bot_id=t.created_by_bot_id
 JOIN conversations c ON c.id=parent.conversation_id AND c.kind='group' AND c.group_id=t.group_id
 WHERE t.id=group_task_sources.task_id AND child.group_id=t.group_id
);
UPDATE group_task_sources SET
 kind='coordinator',
 message_id=(SELECT parent.message_id FROM runs child JOIN runs parent ON parent.id=child.parent_run_id
   JOIN group_tasks t ON t.id=child.task_id AND parent.group_id=t.group_id AND parent.bot_id=t.created_by_bot_id
   JOIN conversations c ON c.id=parent.conversation_id AND c.kind='group' AND c.group_id=t.group_id
   WHERE child.task_id=group_task_sources.task_id AND child.kind='group_task' AND child.group_id=t.group_id
   ORDER BY child.created_at,child.id LIMIT 1),
 conversation_id=(SELECT parent.conversation_id FROM runs child JOIN runs parent ON parent.id=child.parent_run_id
   JOIN group_tasks t ON t.id=child.task_id AND parent.group_id=t.group_id AND parent.bot_id=t.created_by_bot_id
   JOIN conversations c ON c.id=parent.conversation_id AND c.kind='group' AND c.group_id=t.group_id
   WHERE child.task_id=group_task_sources.task_id AND child.kind='group_task' AND child.group_id=t.group_id
   ORDER BY child.created_at,child.id LIMIT 1),
 batch_message_id=(SELECT parent.message_id FROM runs child JOIN runs parent ON parent.id=child.parent_run_id
   JOIN group_tasks t ON t.id=child.task_id AND parent.group_id=t.group_id AND parent.bot_id=t.created_by_bot_id
   JOIN conversations c ON c.id=parent.conversation_id AND c.kind='group' AND c.group_id=t.group_id
   WHERE child.task_id=group_task_sources.task_id AND child.kind='group_task' AND child.group_id=t.group_id
   ORDER BY child.created_at,child.id LIMIT 1)
WHERE kind<>'unknown';
