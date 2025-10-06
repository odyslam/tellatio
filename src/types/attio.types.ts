export interface AttioPersonAttributes {
  telegram_user_id?: string;
  telegram_username?: string;
  telegram_first_name?: string;
  telegram_last_name?: string;
  email?: string;
  name?: string;
}

export interface AttioCompanyAttributes {
  default_telegram_chat?: string;
  name?: string;
}

export interface AttioTelegramChatAttributes {
  chat_id: string;
  title?: string;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  company?: string;
}

export interface AttioNoteData {
  parent_object: string;
  parent_record_id: string;
  title: string;
  content: string;
  format: 'plaintext' | 'markdown';
  created_at: string;
}

export interface AttioTaskData {
  parent_object: string;
  parent_record_id: string;
  title: string;
  description?: string;
  assignee?: string;
  due_date?: string;
  status?: 'pending' | 'in_progress' | 'completed';
}

export interface AttioRecord {
  id: {
    record_id: string;
    object_id: string;
  };
  values: Record<string, any>;
  created_at: string;
  modified_at: string;
}