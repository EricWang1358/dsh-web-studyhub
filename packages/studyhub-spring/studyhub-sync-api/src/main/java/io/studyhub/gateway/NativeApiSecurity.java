package io.studyhub.gateway;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration(proxyBeanMethods = false)
class NativeApiSecurity implements WebMvcConfigurer {
    private final LocalRequestFilter guard;

    NativeApiSecurity(LocalRequestFilter guard) {
        this.guard = guard;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(new HandlerInterceptor() {
            @Override
            public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) throws IOException {
                return guard.authorize(request, response);
            }
        }).addPathPatterns("/api/ai/**", "/api/retrieval/**", "/api/sync/desktop-history/**");
    }
}
