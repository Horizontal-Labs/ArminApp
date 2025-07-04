import { ref, computed, type Ref, type ComputedRef } from 'vue'
import { z } from 'zod'

// Zod Schemas
const TextAnalysisRequestSchema = z.object({
  text: z.string().min(1, 'Text cannot be empty'),
  chatId: z.string(),
  analysisMode: z.enum(['comprehensive', 'quick', 'detailed']).default('comprehensive'),
})

const FileAnalysisRequestSchema = z.object({
  file: z.instanceof(File),
  chatId: z.string(),
  analysisMode: z.enum(['comprehensive', 'quick', 'detailed']).default('comprehensive'),
})

// Type definitions
interface ChatItem {
  id: string
  title: string
  createdAt: string
}

interface FileInfo {
  name: string
  size: number
}

interface BaseMessage {
  id: string
  timestamp: string
  type: 'user' | 'assistant'
}

interface UserMessage extends BaseMessage {
  type: 'user'
  text: string
  fileInfo: FileInfo | null
}

interface AssistantMessage extends BaseMessage {
  type: 'assistant'
  isLoading: boolean
  analysis: unknown | null
}

type Message = UserMessage | AssistantMessage

interface MessageData {
  text?: string
  file?: File
}

interface NewMessageData {
  type: 'user' | 'assistant'
  text?: string
  fileInfo?: FileInfo | null
  isLoading?: boolean
  analysis?: unknown | null
  id?: string
}

interface MessageUpdate {
  isLoading?: boolean
  analysis?: unknown
}

// Global state
const currentChatId: Ref<string | null> = ref(null)
const chatHistory: Ref<ChatItem[]> = ref([])
const messages: Ref<Map<string, Message[]>> = ref(new Map())
const isAnalyzing: Ref<boolean> = ref(false)
const error: Ref<string> = ref('')

const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000'

export interface UseChatReturn {
  // State
  currentChatId: Ref<string | null>
  chatHistory: Ref<ChatItem[]>
  currentMessages: ComputedRef<Message[]>
  isAnalyzing: Ref<boolean>
  error: Ref<string>

  // Methods
  startNewChat: () => string
  deleteChat: (chatId: string) => void
  selectChat: (chatId: string) => void
  sendMessage: (messageData: MessageData) => Promise<void>
  loadData: () => void
  formatDate: (date: string | number | Date) => string
  formatTime: (date: string | number | Date) => string
}

export function useChat(): UseChatReturn {
  // Computed
  const currentMessages: ComputedRef<Message[]> = computed(() => {
    return currentChatId.value ? messages.value.get(currentChatId.value) || [] : []
  })

  // Utility functions
  const generateId = (): string => Math.random().toString(36).substr(2, 9)

  const formatDate = (date: string | number | Date): string => {
    return new Date(date).toLocaleDateString()
  }

  const formatTime = (date: string | number | Date): string => {
    return new Date(date).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  // Chat management
  const startNewChat = (): string => {
    const chatId = generateId()
    const newChat: ChatItem = {
      id: chatId,
      title: 'New Chat',
      createdAt: new Date().toISOString(),
    }

    chatHistory.value.unshift(newChat)
    messages.value.set(chatId, [])
    currentChatId.value = chatId

    saveChatHistory()
    return chatId
  }

  const deleteChat = (chatId: string): void => {
    chatHistory.value = chatHistory.value.filter(c => c.id !== chatId)
    messages.value.delete(chatId)

    // If the deleted chat was the current one, reset currentChatId
    if (currentChatId.value === chatId) {
      currentChatId.value = null
    }

    saveChatHistory()
    saveMessages()
  }

  const selectChat = (chatId: string): void => {
    currentChatId.value = chatId
  }

  const updateChatTitle = (chatId: string, title: string): void => {
    const chat = chatHistory.value.find(c => c.id === chatId)
    if (chat) {
      chat.title = title.length > 50 ? title.substring(0, 50) + '...' : title
      saveChatHistory()
    }
  }

  // Message handling
  const addMessage = (chatId: string, message: NewMessageData): void => {
    if (!messages.value.has(chatId)) {
      messages.value.set(chatId, [])
    }

    const fullMessage: Message = {
      id: message.id || generateId(),
      timestamp: new Date().toISOString(),
      type: message.type,
      ...(message.type === 'user'
        ? {
          text: message.text || '',
          fileInfo: message.fileInfo || null
        }
        : {
          isLoading: message.isLoading || false,
          analysis: message.analysis || null
        })
    } as Message

    messages.value.get(chatId)!.push(fullMessage)
    saveMessages()
  }

  const updateMessage = (chatId: string, messageId: string, updates: MessageUpdate): void => {
    const chatMessages = messages.value.get(chatId)
    if (chatMessages) {
      const messageIndex = chatMessages.findIndex(m => m.id === messageId)
      if (messageIndex !== -1) {
        Object.assign(chatMessages[messageIndex], updates)
        saveMessages()
      }
    }
  }

  // API calls
  const sendMessage = async (messageData: MessageData): Promise<void> => {
    const { text, file } = messageData

    if (!text?.trim() && !file) return

    // Ensure we have a current chat
    if (!currentChatId.value) {
      startNewChat()
    }

    const chatId = currentChatId.value!

    // we'll need this ID later in the catch block
    let assistantMessageId: string | null = null

    try {
      error.value = ''
      isAnalyzing.value = true

      // Add user message
      const userMessage: NewMessageData = {
        type: 'user',
        text: text?.trim() || '',
        fileInfo: file ? { name: file.name, size: file.size } : null
      }

      addMessage(chatId, userMessage)

      // Update chat title if it's the first message
      const chatMessages = messages.value.get(chatId)
      if (chatMessages && chatMessages.length === 1) {
        const title = text?.trim() || file?.name || 'File Analysis'
        updateChatTitle(chatId, title)
      }

      // Add loading assistant message
      assistantMessageId = generateId()
      addMessage(chatId, {
        id: assistantMessageId,
        type: 'assistant',
        isLoading: true,
        analysis: null
      })

      let response: Response

      if (file) {
        // File analysis
        const requestData = FileAnalysisRequestSchema.parse({
          file,
          chatId,
        })

        const formData = new FormData()
        formData.append('file', requestData.file)
        formData.append('chatId', requestData.chatId)
        formData.append('analysisMode', requestData.analysisMode)
        if (text?.trim()) {
          formData.append('additionalText', text.trim())
        }

        response = await fetch(`${API_BASE_URL}/api/analyze/file`, {
          method: 'POST',
          body: formData,
        })
      } else {
        // Text analysis
        const requestData = TextAnalysisRequestSchema.parse({
          text: text!.trim(),
          chatId,
        })

        response = await fetch(`${API_BASE_URL}/api/analyze/text`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestData),
        })
      }

      if (!response.ok) {
        throw new Error(`Analysis failed: ${response.statusText}`)
      }

      const result: unknown = await response.json()

      // Update assistant message with results
      updateMessage(chatId, assistantMessageId, {
        isLoading: false,
        analysis: result
      })

    } catch (err) {

      const friendly = 'An error has occurred, try to send a message again'

      if (err instanceof z.ZodError) {
        error.value = `Validation error: ${err.errors[0].message}`
      } else {
        error.value = err instanceof Error ? err.message : 'Failed to analyze'
      }
      console.error('Analysis error:', err)

      if (assistantMessageId !== null) {
        updateMessage(chatId, assistantMessageId, {
          isLoading: false,
          analysis: friendly
        })
      }
    } finally {
      isAnalyzing.value = false
    }
  }

  // Persistence
  const saveChatHistory = (): void => {
    try {
      localStorage.setItem('armins-chat-history', JSON.stringify(chatHistory.value))
    } catch (err) {
      console.error('Failed to save chat history:', err)
    }
  }

  const saveMessages = (): void => {
    try {
      const messagesObj = Object.fromEntries(messages.value)
      localStorage.setItem('armins-messages', JSON.stringify(messagesObj))
    } catch (err) {
      console.error('Failed to save messages:', err)
    }
  }

  const loadData = (): void => {
    try {
      // Load chat history
      const savedHistory = localStorage.getItem('armins-chat-history')
      if (savedHistory) {
        const parsedHistory = JSON.parse(savedHistory) as ChatItem[]
        chatHistory.value = parsedHistory
      }

      // Load messages
      const savedMessages = localStorage.getItem('armins-messages')
      if (savedMessages) {
        const messagesObj = JSON.parse(savedMessages) as Record<string, Message[]>
        messages.value = new Map(Object.entries(messagesObj))
      }

      // Select most recent chat if available
      if (chatHistory.value.length > 0) {
        currentChatId.value = chatHistory.value[0].id
      }
    } catch (err) {
      console.error('Failed to load data:', err)
    }
  }

  return {
    // State
    currentChatId,
    chatHistory,
    currentMessages,
    isAnalyzing,
    error,

    // Methods
    startNewChat,
    deleteChat,
    selectChat,
    sendMessage,
    loadData,
    formatDate,
    formatTime,
  }
}

// Export types for use in components
export type { ChatItem, Message, UserMessage, AssistantMessage, MessageData, FileInfo }