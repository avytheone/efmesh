SELECT id, happened_at
FROM @ref(src.events)
WHERE happened_at >= @start AND happened_at < @end
