import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { qdrantRAG } from '@/lib/qdrant-rag';

// Simple in-memory cache
const responseCache = new Map<string, string>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const cacheTimestamps = new Map<string, number>();

interface SourceTimestamp {
  course: string;
  section: string;
  videoId: string;
  timestamp: string;
  relevance: string;
}

// Helper function to create cache key
const getCacheKey = (query: string): string => {
  return query
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .trim()
    .split(/\s+/)
    .sort()
    .join(' ');
};

// Clean expired cache entries
const cleanCache = () => {
  const now = Date.now();
  for (const [key, timestamp] of cacheTimestamps.entries()) {
    if (now - timestamp > CACHE_TTL) {
      responseCache.delete(key);
      cacheTimestamps.delete(key);
    }
  }
};

export const POST = async (req: Request) => {
  try {
    const startTime = Date.now();
    const { messages, course } = await req.json();
    const lastMessage = messages[messages.length - 1];
    const userQuery = lastMessage.content;
    const selectedCourse = course || 'both';

    console.log('🔍 User query:', userQuery);

    // Check cache first
    const cacheKey = getCacheKey(userQuery);
    cleanCache();

    if (responseCache.has(cacheKey)) {
      console.log('📦 Cache hit for query');
      return new Response(responseCache.get(cacheKey));
    }

    // Optimize RAG search with Promise.all for parallel processing
    let ragContext = '';
    let sourceTimestamps: SourceTimestamp[] = [];

    const ragPromise = (async () => {
      try {
        await qdrantRAG.initialize();
        
        // Enhanced search with course filtering and HYDE
        const searchResults = await qdrantRAG.search(
          userQuery, 
          5, // Get more results for better context
          selectedCourse as 'nodejs' | 'python' | 'both'
        );

        if (searchResults?.length > 0) {
          // Ensure unique references with proper timestamps
          const uniqueResults = new Map<string, typeof searchResults[0]>();
          
          searchResults.forEach(result => {
            const key = `${result.metadata.videoId}-${Math.floor(result.metadata.startTime / 10) * 10}`; // 10-second windows
            if (!uniqueResults.has(key) || (uniqueResults.get(key)!.score < result.score)) {
              uniqueResults.set(key, result);
            }
          });
          
          const finalResults = Array.from(uniqueResults.values())
            .sort((a, b) => b.score - a.score)
            .slice(0, 3); // Limit to 3 unique references
          
          sourceTimestamps = finalResults.map(
            (result): SourceTimestamp => ({
              course: result.metadata.course || 'Unknown',
              section: result.metadata.section || 'General',
              videoId: result.metadata.videoId || 'unknown',
              timestamp: formatTimestamp(result.metadata.startTime),
              relevance: result.metadata.relevance_reason || 'Relevant content',
            }),
          );

          // Create rich context from unique results with better formatting
          ragContext = finalResults
            .map(
              (result, index) =>
                `## Context ${index + 1}: ${result.metadata.course.toUpperCase()} - ${result.metadata.section} (${formatTimestamp(result.metadata.startTime)})
**Relevance**: ${result.metadata.relevance_reason}
**Content**: ${result.content.trim()}`,
            )
            .join('\n\n')
            .substring(0, 4000); // Increased for richer context
        }
      } catch (error: unknown) {
        console.error('Enhanced Qdrant RAG search failed:', error);
      }
    })();

    // Wait for RAG to complete
    await ragPromise;

    const systemPrompt = `You are FlowMind, an AI assistant specializing in Node.js and Python programming.

${
  ragContext
    ? `## Relevant Course Material:
${ragContext}

Use the above course material as your primary reference.`
    : ''
}

Provide clear, practical programming guidance. Keep responses focused and under 300 words for faster delivery.`;

    const result = streamText({
      model: openai('gpt-4o-mini'), // Fastest model
      system: systemPrompt,
      messages,
      temperature: 0.7, // Lower for speed and focus
      // maxTokens: 500, // Limit response length
      topP: 1,
    });

    const response = result.toTextStreamResponse();

    // Add sources header
    if (sourceTimestamps.length > 0) {
      response.headers.set('X-Sources', JSON.stringify(sourceTimestamps));
    }

    // Cache the response for common queries
    const responseText = await response.text();
    responseCache.set(cacheKey, responseText);
    cacheTimestamps.set(cacheKey, Date.now());

    const endTime = Date.now();
    console.log(`⚡ Response time: ${endTime - startTime}ms`);

    return new Response(responseText, {
      headers: response.headers,
    });
  } catch (error: unknown) {
    console.error('Chat API error:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
};

const formatTimestamp = (seconds: number | undefined): string => {
  if (!seconds || isNaN(seconds) || seconds <= 0) {
    return '0:00';
  }
  
  const validSeconds = Math.max(0, Math.floor(seconds));
  const totalMinutes = Math.floor(validSeconds / 60);
  const remainingSeconds = validSeconds % 60;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  }
  
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
};
