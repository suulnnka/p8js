--
        if (_init) _init()
        if _update or _update60 or _draw then
            while true do
                if _update60 then
                    _update_buttons()
                    _update60()
                else
                    yield() -- yield each other frame for 30fps
                    _update_buttons()
                    if (_update) _update()
                end
                if _draw then
                    _draw()
                    flip()
                else
                    yield()
                end
            end
        end
    